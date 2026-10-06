import { Chacha20Poly1305 } from '@hpke/chacha20poly1305'
import { CipherSuite, HkdfSha256 } from '@hpke/core'
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519'
import { sha256 } from '@noble/hashes/sha2.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH } from '.'
import { type GatewayKey, hpkeInfo, sealToGateway } from './hpke'

const GATEWAY_FIXTURE = new URL('../../gateway/tests/fixtures/hpke-gateway.json', import.meta.url)
const APP_FIXTURE = new URL('../../gateway/tests/fixtures/hpke-app.json', import.meta.url)
const gatewaySealed = JSON.parse(readFileSync(GATEWAY_FIXTURE, 'utf8'))

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
})
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))
const plaintext = (size: number) => Uint8Array.from({ length: size }, (_, i) => i % 251)
const AAD = new TextEncoder().encode('aad')

/** The fixtures' key: RFC 9180 `DeriveKeyPair` from 32 bytes of 7, published as the gateway does. */
async function testKey() {
  const keyPair = await suite.kem.deriveKeyPair(hexToBytes(gatewaySealed.ikm).buffer as ArrayBuffer)
  const publicKey = new Uint8Array(await suite.kem.serializePublicKey(keyPair.publicKey))
  const published: GatewayKey = {
    keyId: sha256(publicKey)[0],
    kemId: 0x20,
    kdfId: 1,
    aeadId: 3,
    publicKey: base64(publicKey),
  }
  return { keyPair, published }
}

async function open(keyPair: CryptoKeyPair, enc: Uint8Array, info: Uint8Array, ciphertext: Uint8Array, aad = AAD) {
  return new Uint8Array(
    await suite.open({ recipientKey: keyPair, enc: enc.buffer as ArrayBuffer, info }, ciphertext, aad),
  )
}

describe('HPKE to the gateway', () => {
  it('separates purposes and clusters in the info', () => {
    const info = hpkeInfo('relay', DEVNET_GENESIS_HASH)
    expect(new TextDecoder().decode(info.subarray(0, 23))).toBe('buckspay/hpke/v1\0relay\0')
    expect(info.subarray(23)).toEqual(DEVNET_GENESIS_HASH)
  })

  it('opens what the gateway library sealed', async () => {
    const { keyPair } = await testKey()
    const info = hpkeInfo(gatewaySealed.purpose, DEVNET_GENESIS_HASH)
    expect(gatewaySealed.messages).toHaveLength(4)
    for (const message of gatewaySealed.messages) {
      expect(await open(keyPair, fromBase64(message.enc), info, fromBase64(message.ciphertext))).toEqual(
        plaintext(message.size),
      )
    }
  })

  it('seals what opens for its purpose, cluster and data only, and gives the gateway its fixture', async () => {
    const { keyPair, published } = await testKey()
    const info = hpkeInfo('test', DEVNET_GENESIS_HASH)
    const messages = []
    for (const size of [0, 1, 227, 4096]) {
      const sealed = await sealToGateway(published, 'test', DEVNET_GENESIS_HASH, plaintext(size), AAD)
      expect(sealed.keyId).toBe(published.keyId)
      expect(await open(keyPair, sealed.enc, info, sealed.ciphertext)).toEqual(plaintext(size))
      for (const [other, aad] of [
        [hpkeInfo('relay', DEVNET_GENESIS_HASH), AAD],
        [hpkeInfo('test', MAINNET_GENESIS_HASH), AAD],
        [info, new TextEncoder().encode('other')],
      ] as const) {
        await expect(open(keyPair, sealed.enc, other, sealed.ciphertext, aad)).rejects.toThrow()
      }
      messages.push({ size, keyId: sealed.keyId, enc: base64(sealed.enc), ciphertext: base64(sealed.ciphertext) })
    }
    if (process.env.WRITE_FIXTURE) {
      writeFileSync(APP_FIXTURE, `${JSON.stringify({ purpose: 'test', aad: base64(AAD), messages }, null, 2)}\n`)
    }
    expect(JSON.parse(readFileSync(APP_FIXTURE, 'utf8')).messages).toHaveLength(4)
  })
})
