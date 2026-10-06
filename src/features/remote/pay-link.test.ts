import { describe, expect, it } from 'vitest'
import { decodePayLink, encodePayLink } from './pay-link'
import { link, OTHER_MINT } from './testing'

describe('pay link', () => {
  it('round-trips as BP: text and carries no device key or amount', () => {
    const text = encodePayLink(link)
    expect(text.startsWith('BP:')).toBe(true)
    expect(decodePayLink(text)).toEqual(link)
  })
  it('refuses another version, a long name, and a mint that is not this cluster’s USDC', () => {
    expect(() => encodePayLink({ ...link, name: 'x'.repeat(33) })).toThrow()
    expect(() => decodePayLink(encodePayLink({ ...link, mint: OTHER_MINT }))).toThrow()
    const t = encodePayLink(link)
    expect(() => decodePayLink(t.replace('BP:', 'BP:Z'))).toThrow()
    expect(() => decodePayLink('not a link')).toThrow()
  })
})
