import { describe, expect, it } from 'vitest'
import { trustedKey } from './key'

const hashes = (n: string) => ({ vkSha256: n + 'v', pkSha256: n + 'p', ccsSha256: n + 'c', dumpSha256: n + 'd' })
const a = hashes('a')
const b = hashes('b')
const c = hashes('c')
const chain = { current: b, previous: { ...a, validUntil: 1_000 } }

describe('trustedKey', () => {
  it('accepts a rotated key announced by the program without an app update', () => {
    expect(trustedKey(b, [a], chain, 500)).toBe(true)
  })
  it('never trusts hashes served only by the gateway', () => {
    expect(trustedKey(c, [a], chain, 500)).toBe(false)
    expect(trustedKey({ ...b, pkSha256: 'p9' }, [a], chain, 500)).toBe(false)
  })
  it('keeps the previous key until rotation + 72 h + grace, then refuses it even if pinned', () => {
    expect(trustedKey(a, [a], chain, 1_000)).toBe(true)
    expect(trustedKey(a, [a], chain, 1_001)).toBe(false)
  })
  it('falls back to the build pin only when the chain cannot be read', () => {
    expect(trustedKey(a, [a], null, 5_000)).toBe(true)
    expect(trustedKey(b, [a], null, 5_000)).toBe(false)
  })
  it('refuses a key that matches in three of four hashes', () => {
    expect(trustedKey({ ...a, dumpSha256: 'x' }, [a], null, 0)).toBe(false)
    expect(trustedKey({ ...b, ccsSha256: 'x' }, [], chain, 0)).toBe(false)
  })
  it('has no previous key when none was rotated', () => {
    expect(trustedKey(a, [a], { current: b }, 0)).toBe(false)
  })
})
