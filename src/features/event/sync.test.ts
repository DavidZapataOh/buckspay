import { describe, expect, it } from 'vitest'
import { decodeSync, encodeSync } from './sync'

const eventId = new Uint8Array(16).fill(1)
const secret = new Uint8Array(32).fill(3)
const entry = (n: number) => ({
  output: new Uint8Array(32).fill(n),
  content: new Uint8Array(32).fill(n + 1),
  signature: new Uint8Array(64).fill(n + 2),
  seenAt: 1_800_000_000 + n,
})

describe('sync messages', () => {
  it('round-trips under the event secret', () => {
    const m = { eventId, from: new Uint8Array(16).fill(9), entries: [entry(1), entry(2)] }
    expect(decodeSync(secret, encodeSync(secret, m))).toEqual(m)
  })

  it('drops a message under another secret or with one flipped byte', () => {
    const wire = encodeSync(secret, { eventId, from: new Uint8Array(16), entries: [entry(1)] })
    expect(decodeSync(new Uint8Array(32).fill(7), wire)).toBeNull()
    const flipped = wire.slice()
    flipped[40] ^= 1
    expect(decodeSync(secret, flipped)).toBeNull()
  })

  it('caps a message at sixty entries', () => {
    const entries = Array.from({ length: 61 }, (_, i) => entry(i))
    expect(() => encodeSync(secret, { eventId, from: new Uint8Array(16), entries })).toThrow()
  })

  it('weighs 67 bytes plus 132 per entry and fits one transport message at the cap', () => {
    const size = (n: number) =>
      encodeSync(secret, { eventId, from: new Uint8Array(16), entries: Array.from({ length: n }, (_, i) => entry(i)) })
        .length
    expect(size(0)).toBe(67)
    expect(size(1)).toBe(67 + 132)
    expect(size(60)).toBe(7_987)
    expect(size(60)).toBeLessThanOrEqual(8_192)
  })

  it('drops a message whose count disagrees with its length', () => {
    const wire = encodeSync(secret, { eventId, from: new Uint8Array(16), entries: [entry(1)] })
    expect(decodeSync(secret, wire.slice(0, wire.length - 1))).toBeNull()
    expect(decodeSync(secret, new Uint8Array(10))).toBeNull()
  })
})
