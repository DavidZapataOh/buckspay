import { p256 } from '@noble/curves/nist.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { DEVNET_GENESIS_HASH, domain, Purpose, verifySignature } from '../protocol'
import { compactLowS, sec1FromSpki } from './convert'
import fixture from './fixtures/p256-der.json'

const cases = fixture.cases.map((c) => ({
  ...c,
  spki: hexToBytes(c.spki),
  message: hexToBytes(c.message),
  der: hexToBytes(c.der),
}))
const error = (code: string) => expect.objectContaining({ name: 'ProtocolError', code })

describe('Keystore format conversion', () => {
  it('uses signatures over devnet note envelopes with every edge case', () => {
    const programId = new Uint8Array(32).fill(0xb0)
    expect(fixture.domain).toBe(bytesToHex(domain(Purpose.Note, DEVNET_GENESIS_HASH, programId)))
    expect(cases.map((c) => c.name)).toEqual(
      expect.arrayContaining(['low_s', 'high_s', 'short_r', 'short_s', 'short_s_after_normalisation']),
    )
  })

  it.each(cases)(
    'converts $name to a low-S signature that verifies',
    ({ spki, message, der, high_s, compact, sec1 }) => {
      const key = sec1FromSpki(spki)
      const signature = compactLowS(der)
      expect(bytesToHex(key)).toBe(sec1)
      expect(bytesToHex(signature)).toBe(compact)
      expect(p256.Signature.fromBytes(signature, 'compact').hasHighS()).toBe(false)
      expect(() => verifySignature(key, message, signature)).not.toThrow()
      const raw = p256.Signature.fromBytes(der, 'der').toBytes('compact')
      expect(high_s).toBe(bytesToHex(raw) !== compact)
      if (high_s) expect(() => verifySignature(key, message, raw)).toThrow(error('Signature'))
    },
  )

  it('rejects malformed DER signatures', () => {
    const { der } = cases[0]
    expect(() => compactLowS(concatBytes(der, Uint8Array.of(0)))).toThrow(error('Signature'))
    const nonMinimal = concatBytes(Uint8Array.of(0x30, der[1] + 1, 0x02, der[3] + 1, 0x00), der.subarray(4))
    expect(() => compactLowS(nonMinimal)).toThrow(error('Signature'))
    expect(() => compactLowS(der.subarray(0, der.length - 1))).toThrow(error('Signature'))
  })

  it('rejects anything but an uncompressed P-256 X.509 key on the curve', () => {
    const { spki } = cases[0]
    const flip = (index: number) => {
      const copy = spki.slice()
      copy[index] ^= 1
      return copy
    }
    expect(() => sec1FromSpki(spki.subarray(0, 90))).toThrow(error('Signer'))
    expect(() => sec1FromSpki(concatBytes(spki, Uint8Array.of(0)))).toThrow(error('Signer'))
    expect(() => sec1FromSpki(flip(22))).toThrow(error('Signer'))
    expect(() => sec1FromSpki(flip(26))).toThrow(error('Signer'))
    expect(() => sec1FromSpki(flip(90))).toThrow(error('Signer'))
  })
})
