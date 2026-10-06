import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'
import { encodeFrames, MAX_FRAMES, MULTI_HEADER_BYTES, Reassembler } from './framing'
import { qrFrameLimits } from './qr/limits'
import { MAX_MESSAGE_BYTES, MessageKind } from './types'
import { waitForMessage } from './wait'

const limits = qrFrameLimits()
const bytes = (length: number, seed = 1) => Uint8Array.from({ length }, (_, i) => (i * 7 + seed) & 0xff)

/** A frame built by hand, the way a peer that does not use `encodeFrames` could send it. */
function forge(kind: number, id: Uint8Array, total: number, index: number, chunk: Uint8Array) {
  const frame = new Uint8Array(MULTI_HEADER_BYTES + chunk.length)
  frame[0] = (1 << 4) | (kind << 1) | 1
  frame.set(id, 1)
  frame[5] = total
  frame[6] = index
  frame.set(chunk, MULTI_HEADER_BYTES)
  return frame
}

describe('frame limits', () => {
  it('accepts exactly MAX_FRAMES frames and refuses one more', () => {
    const multi = { single: 1, multi: MULTI_HEADER_BYTES + 1 }
    expect(encodeFrames({ kind: MessageKind.Payment, payload: bytes(MAX_FRAMES) }, multi)).toHaveLength(MAX_FRAMES)
    expect(() => encodeFrames({ kind: MessageKind.Payment, payload: bytes(MAX_FRAMES + 1) }, multi)).toThrow(/TooLarge/)
  })

  it('accepts a payload of MAX_MESSAGE_BYTES and refuses one byte more', () => {
    expect(encodeFrames({ kind: MessageKind.Payment, payload: bytes(MAX_MESSAGE_BYTES) }, limits).length).toBe(42)
    expect(() => encodeFrames({ kind: 7 as MessageKind, payload: bytes(MAX_MESSAGE_BYTES + 1) }, limits)).toThrow(
      /TooLarge/,
    )
  })

  it('refuses kind 8 and accepts kind 7', () => {
    expect(() => encodeFrames({ kind: 8 as MessageKind, payload: bytes(1) }, limits)).toThrow(/Malformed/)
    expect(encodeFrames({ kind: 7 as MessageKind, payload: bytes(1) }, limits)).toHaveLength(1)
  })
})

describe('Reassembler against frames it did not encode', () => {
  it('ignores a single frame of another version', () => {
    expect(new Reassembler().push(Uint8Array.of(0x20 | 0x02, 1, 2))).toEqual({ status: 'ignored' })
  })

  it('ignores a single frame above the message limit', () => {
    const frame = new Uint8Array(MAX_MESSAGE_BYTES + 2)
    frame[0] = 0x12
    expect(new Reassembler().push(frame)).toEqual({ status: 'ignored' })
  })

  it('reports a rebuilt payload above the message limit as corrupt even when its id matches', () => {
    const payload = bytes(MAX_MESSAGE_BYTES + 1)
    const id = sha256(payload).slice(0, 4)
    const half = Math.ceil(payload.length / 2)
    const reassembler = new Reassembler()
    reassembler.push(forge(1, id, 2, 0, payload.subarray(0, half)))
    expect(reassembler.push(forge(1, id, 2, 1, payload.subarray(half)))).toEqual({ status: 'corrupt' })
  })

  it('does not mix frames of the same id and total but another kind', () => {
    const payload = bytes(10)
    const id = sha256(payload).slice(0, 4)
    const reassembler = new Reassembler()
    reassembler.push(forge(MessageKind.Payment, id, 2, 0, payload.subarray(0, 5)))
    expect(reassembler.push(forge(MessageKind.Receipt, id, 2, 1, payload.subarray(5)))).toMatchObject({
      status: 'progress',
      received: 1,
      restarted: true,
    })
  })

  it('does not mix frames of the same id and kind but another total', () => {
    const payload = bytes(9)
    const id = sha256(payload).slice(0, 4)
    const reassembler = new Reassembler()
    reassembler.push(forge(MessageKind.Payment, id, 3, 0, payload.subarray(0, 3)))
    expect(reassembler.push(forge(MessageKind.Payment, id, 2, 1, payload.subarray(3)))).toMatchObject({
      status: 'progress',
      received: 1,
      restarted: true,
    })
  })

  it('accepts a total of exactly MAX_FRAMES', () => {
    const payload = bytes(MAX_FRAMES)
    const id = sha256(payload).slice(0, 4)
    const reassembler = new Reassembler()
    let result
    for (let index = 0; index < MAX_FRAMES; index++) {
      result = reassembler.push(forge(1, id, MAX_FRAMES, index, payload.subarray(index, index + 1)))
    }
    expect(result).toMatchObject({ status: 'complete' })
  })
})

describe('waitForMessage', () => {
  it('rejects at once for a signal that is already aborted, without starting', async () => {
    const controller = new AbortController()
    controller.abort()
    let started = false
    await expect(
      waitForMessage({ signal: controller.signal }, () => {
        started = true
        return () => {}
      }),
    ).rejects.toThrow(/Cancelled/)
    expect(started).toBe(false)
  })

  it('runs the cleanup when the start delivers synchronously', async () => {
    let cleaned = 0
    const message = { kind: MessageKind.Request, payload: new Uint8Array(0) }
    await waitForMessage(undefined, (deliver) => {
      deliver(message)
      return () => void cleaned++
    })
    expect(cleaned).toBe(1)
  })
})
