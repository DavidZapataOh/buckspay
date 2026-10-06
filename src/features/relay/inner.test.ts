import { describe, expect, it } from 'vitest'
import { BUCKETS, encodeInner } from './inner'

describe('inner message', () => {
  it('pads to the smallest bucket that fits and never leaks the hop count within a bucket', () => {
    const one = encodeInner(new Uint8Array(140), [new Uint8Array(150)])
    const three = encodeInner(new Uint8Array(140), [new Uint8Array(150), new Uint8Array(150), new Uint8Array(150)])
    expect(one.length).toBe(1024)
    expect(three.length).toBe(1024)
    expect(encodeInner(new Uint8Array(140), Array(16).fill(new Uint8Array(150))).length).toBe(4096)
  })

  it('refuses more than sixteen spends or more than the largest bucket', () => {
    expect(() => encodeInner(new Uint8Array(140), Array(17).fill(new Uint8Array(10)))).toThrow()
    expect(() => encodeInner(new Uint8Array(140), [new Uint8Array(BUCKETS[3])])).toThrow()
  })

  it('carries a note with no spend: the issue of a payment to an account is settled as it is', () => {
    expect(encodeInner(new Uint8Array(140), []).length).toBe(1024)
  })

  it('lays the message out as the gateway reads it', () => {
    const inner = encodeInner(Uint8Array.of(7, 7), [Uint8Array.of(8)])
    expect([...inner.subarray(0, 11)]).toEqual([1, 1, 0, 2, 7, 7, 1, 0, 1, 8, 0])
    expect(inner.subarray(10).every((byte) => byte === 0)).toBe(true)
  })
})
