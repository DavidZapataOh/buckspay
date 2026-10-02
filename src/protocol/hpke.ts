import { Chacha20Poly1305 } from '@hpke/chacha20poly1305'
import { CipherSuite, HkdfSha256 } from '@hpke/core'
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519'

/** RFC 9180 identifiers of the one suite the gateway accepts. */
export const HPKE_SUITE = { kemId: 0x0020, kdfId: 0x0001, aeadId: 0x0003 } as const

/** A key of the gateway's `/v1/hpke-config`. */
export type GatewayKey = { keyId: number; kemId: number; kdfId: number; aeadId: number; publicKey: string }

/** A message sealed to a gateway key. */
export type Sealed = { keyId: number; enc: Uint8Array; ciphertext: Uint8Array }

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
})

/**
 * The HPKE `info` of a message for `purpose` on the cluster with `genesisHash`: a sealed message
 * opens only for the purpose and cluster it was sealed for.
 */
export function hpkeInfo(purpose: string, genesisHash: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode(`buckspay/hpke/v1\0${purpose}\0`)
  const info = new Uint8Array(label.length + genesisHash.length)
  info.set(label)
  info.set(genesisHash, label.length)
  return info
}

/** The gateway public keys this build trusts, base64, fixed when its bundle is made. */
export const PINNED_GATEWAY_KEYS: readonly string[] = (process.env.EXPO_PUBLIC_GATEWAY_HPKE_KEYS ?? '')
  .split(',')
  .filter(Boolean)

/**
 * The first key of the gateway's configuration that `pinned` holds, in the one suite the app
 * speaks. A key the build does not pin is never used, whatever the gateway publishes: during a
 * rotation the gateway publishes the new key first and keeps the old one, and an app that pins
 * only the old one keeps sealing to it.
 */
export function pinnedKey(published: readonly GatewayKey[], pinned: readonly string[]): GatewayKey {
  const key = published.find(
    (key) =>
      pinned.includes(key.publicKey) &&
      key.kemId === HPKE_SUITE.kemId &&
      key.kdfId === HPKE_SUITE.kdfId &&
      key.aeadId === HPKE_SUITE.aeadId,
  )
  if (!key) throw new Error('The gateway publishes no key this app trusts.')
  return key
}

const base64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))

/** Seals `plaintext` to a pinned gateway key for `purpose` on the cluster with `genesisHash`. */
export async function sealToGateway(
  key: GatewayKey,
  purpose: string,
  genesisHash: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Sealed> {
  const recipientPublicKey = await suite.kem.deserializePublicKey(base64(key.publicKey))
  const { enc, ct } = await suite.seal({ recipientPublicKey, info: hpkeInfo(purpose, genesisHash) }, plaintext, aad)
  return { keyId: key.keyId, enc: new Uint8Array(enc), ciphertext: new Uint8Array(ct) }
}
