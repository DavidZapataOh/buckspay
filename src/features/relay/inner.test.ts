import { describe, expect, it } from 'vitest'
import vectors from '../../../gateway/tests/vectors/inner-kind2.json'
import { BUCKETS, encodeInner, encodeWord } from './inner'

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'))

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

  it('lays a tip out as the gateway reads it: kind 2, and the word after the spends', () => {
    const inner = encodeInner(Uint8Array.of(7, 7), [Uint8Array.of(8)], Uint8Array.of(9, 9, 9))
    expect([...inner.subarray(0, 14)]).toEqual([1, 2, 0, 2, 7, 7, 1, 0, 1, 8, 9, 9, 9, 0])
    expect(encodeInner(new Uint8Array(140), [], new Uint8Array(1000)).length).toBe(2048)
  })

  it('builds the bytes the gateway parses into the same commitment, signature and proof', () => {
    const word = encodeWord(bytes(vectors.commitment), bytes(vectors.signature), bytes(vectors.proof))
    expect(Buffer.from(encodeInner(bytes(vectors.issue), [], word)).toString('hex')).toBe(vectors.inner)
  })
})
