import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'
import { encodeFrames, MAX_FRAMES, MULTI_HEADER_BYTES, Reassembler } from './framing'
import { qrFrameLimits } from './qr/limits'
import { type Message, MAX_MESSAGE_BYTES, MessageKind, TransportError } from './types'
import { seeded } from './testing/random'

const limits = qrFrameLimits()
const payload = (length: number, seed = 1) => {
  const random = seeded(seed)
  return Uint8Array.from({ length }, () => Math.floor(random() * 256))
}
const message = (length: number, seed = 1): Message => ({ kind: MessageKind.Payment, payload: payload(length, seed) })

function assemble(frames: Uint8Array[]) {
  const reassembler = new Reassembler()
  let last
  for (const frame of frames) last = reassembler.push(frame)
  return last
}

describe('encodeFrames', () => {
  it('puts a payment of 387 bytes (an issue, its ticket and two counts) in one frame', () => {
    const frames = encodeFrames(message(387), limits)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toHaveLength(388)
  })

  it('keeps the largest single-frame payload in one frame and splits one byte more', () => {
    const largest = limits.single - 1
    expect(encodeFrames(message(largest), limits)).toHaveLength(1)
    expect(encodeFrames(message(largest + 1), limits).length).toBeGreaterThan(1)
  })

  it('splits a payment one hop longer than a first payment (760 bytes) into equal-sized frames within the limit', () => {
    const frames = encodeFrames(message(760), limits)
    expect(frames.length).toBe(4)
    for (const frame of frames) expect(frame.length).toBeLessThanOrEqual(limits.multi)
    const sizes = frames.map((frame) => frame.length - MULTI_HEADER_BYTES)
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(frames.length)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(760)
  })

  it('gives every frame of a message the same session id, the sha-256 prefix of the payload', () => {
    const { payload: bytes } = message(1136)
    const frames = encodeFrames({ kind: MessageKind.Payment, payload: bytes }, limits)
    for (const frame of frames) expect(frame.slice(1, 5)).toEqual(sha256(bytes).slice(0, 4))
  })

  it('refuses a payload above the message limit, and one that needs more than the frame limit', () => {
    expect(() => encodeFrames(message(MAX_MESSAGE_BYTES + 1), limits)).toThrow(TransportError)
    expect(() => encodeFrames(message(MAX_MESSAGE_BYTES), { single: 10, multi: MULTI_HEADER_BYTES + 100 })).toThrow(
      /TooLarge/,
    )
    expect(MAX_FRAMES).toBe(64)
  })

  it('refuses a kind outside 0 to 7', () => {
    expect(() => encodeFrames({ kind: 8 as MessageKind, payload: new Uint8Array(1) }, limits)).toThrow(/Malformed/)
  })
})

describe('Reassembler', () => {
  it.each([0, 1, 100, 387, 397, 398, 399, 760, 1136, 4144, 6400, MAX_MESSAGE_BYTES])(
    'rebuilds a payload of %i bytes from its frames in order',
    (length) => {
      const original = message(length, length + 1)
      const result = assemble(encodeFrames(original, limits))
      expect(result).toEqual({ status: 'complete', message: original })
    },
  )

  it('rebuilds a payload from frames in any order with duplicates', () => {
    const original = message(1888, 9)
    const frames = encodeFrames(original, limits)
    const random = seeded(3)
    const shuffled = [...frames, ...frames.slice(0, 3)].sort(() => random() - 0.5)
    const reassembler = new Reassembler()
    let result
    for (const frame of shuffled) result = reassembler.push(frame)
    expect(result).toEqual({ status: 'complete', message: original })
  })

  it('reports progress, marks a repeated frame as a duplicate and never completes with one missing', () => {
    const frames = encodeFrames(message(1136, 4), limits)
    const reassembler = new Reassembler()
    const seen = frames.slice(0, -1).map((frame) => reassembler.push(frame))
    expect(seen.map((r) => r.status === 'progress' && r.received)).toEqual(frames.slice(0, -1).map((_, i) => i + 1))
    const again = reassembler.push(frames[0])
    expect(again).toMatchObject({ status: 'progress', received: frames.length - 1, duplicate: true })
    expect(reassembler.push(frames.at(-1)!)).toMatchObject({ status: 'complete' })
  })

  it('starts over when frames of another message arrive, and finishes the new one', () => {
    const first = encodeFrames(message(1136, 1), limits)
    const second = message(1136, 2)
    const reassembler = new Reassembler()
    reassembler.push(first[0])
    reassembler.push(first[1])
    let result
    for (const frame of encodeFrames(second, limits)) result = reassembler.push(frame)
    expect(result).toEqual({ status: 'complete', message: second })
  })

  it('flags the restart on the first frame of the other message', () => {
    const reassembler = new Reassembler()
    reassembler.push(encodeFrames(message(1136, 1), limits)[0])
    expect(reassembler.push(encodeFrames(message(1136, 2), limits)[1])).toMatchObject({
      status: 'progress',
      restarted: true,
    })
  })

  it('reports corruption when the payload does not match its id, then rebuilds on the next pass', () => {
    const original = message(1136, 5)
    const frames = encodeFrames(original, limits)
    const damaged = frames.map((frame) => frame.slice())
    damaged[2][MULTI_HEADER_BYTES + 3] ^= 0x01
    const reassembler = new Reassembler()
    let result
    for (const frame of damaged) result = reassembler.push(frame)
    expect(result).toEqual({ status: 'corrupt' })
    for (const frame of frames) result = reassembler.push(frame)
    expect(result).toEqual({ status: 'complete', message: original })
  })

  it.each([
    ['an empty frame', Uint8Array.of()],
    ['another version', Uint8Array.of(0x21, 1, 2)],
    ['a multi-frame header with no chunk', Uint8Array.of(0x13, 1, 2, 3, 4, 2, 0)],
    ['a total of one', Uint8Array.of(0x13, 1, 2, 3, 4, 1, 0, 9)],
    ['a total above the limit', Uint8Array.of(0x13, 1, 2, 3, 4, MAX_FRAMES + 1, 0, 9)],
    ['an index at the total', Uint8Array.of(0x13, 1, 2, 3, 4, 3, 3, 9)],
  ])('ignores %s', (_, frame) => {
    expect(new Reassembler().push(frame)).toEqual({ status: 'ignored' })
  })

  it('rebuilds a payload whose last chunk is a single byte', () => {
    const original = message(7, 11)
    const frames = encodeFrames(original, { single: 1, multi: MULTI_HEADER_BYTES + 3 })
    expect(frames.map((frame) => frame.length - MULTI_HEADER_BYTES)).toEqual([3, 3, 1])
    expect(assemble(frames)).toEqual({ status: 'complete', message: original })
  })

  it('reads the kind from the header', () => {
    for (const kind of [MessageKind.Request, MessageKind.Payment, MessageKind.Receipt]) {
      const result = assemble(encodeFrames({ kind, payload: payload(5) }, limits))
      expect(result).toMatchObject({ status: 'complete', message: { kind } })
    }
  })
})
