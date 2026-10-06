import { describe, expect, it } from 'vitest'
import { base45Capacity, base45Decode, base45Encode } from './base45'

const ascii = (text: string) => Uint8Array.from(Buffer.from(text, 'latin1'))

describe('base45 (RFC 9285)', () => {
  it.each([
    ['AB', 'BB8'],
    ['Hello!!', '%69 VD92EX0'],
    ['base-45', 'UJCLQE7W581'],
    ['ietf!', 'QED8WEX0'],
  ])('encodes %s as the RFC vector %s', (plain, encoded) => {
    expect(base45Encode(ascii(plain))).toBe(encoded)
    expect(base45Decode(encoded)).toEqual(ascii(plain))
  })

  it('round-trips every length from 0 to 64 and every single byte', () => {
    for (let length = 0; length <= 64; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff)
      expect(base45Decode(base45Encode(bytes))).toEqual(bytes)
    }
    for (let value = 0; value < 256; value++)
      expect(base45Decode(base45Encode(Uint8Array.of(value)))).toEqual(Uint8Array.of(value))
  })

  it.each([
    ['a character outside the alphabet', 'bb8'],
    ['a trailing lone character', 'BB8A'],
    ['a triple above 0xFFFF', 'GGW'],
    ['a pair above 0xFF', 'GG'],
  ])('rejects %s', (_, text) => {
    expect(base45Decode(text)).toBeNull()
  })

  it('computes how many bytes fit in a number of characters', () => {
    for (let chars = 0; chars <= 90; chars++) {
      const capacity = base45Capacity(chars)
      expect(base45Encode(new Uint8Array(capacity)).length).toBeLessThanOrEqual(chars)
      expect(base45Encode(new Uint8Array(capacity + 1)).length).toBeGreaterThan(chars)
    }
  })
})
