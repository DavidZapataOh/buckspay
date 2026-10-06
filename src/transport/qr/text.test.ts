import { describe, expect, it } from 'vitest'
import { encodeFrames } from '../framing'
import { type Message, MessageKind } from '../types'
import { QR_CHARS, qrFrameLimits, TEXT_PREFIX } from './limits'
import { frameToText, textToFrame } from './text'

const limits = qrFrameLimits()
const bytes = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 13 + 5) & 0xff)

describe('QR text', () => {
  it('prefixes frames so a scanner can ignore every other code', () => {
    expect(frameToText(Uint8Array.of(0x12, 1)).startsWith(TEXT_PREFIX)).toBe(true)
    expect(textToFrame('https://example.com')).toBeNull()
    expect(textToFrame(`${TEXT_PREFIX}not base45!`)).toBeNull()
  })

  it('round-trips a frame through its text', () => {
    const frame = bytes(100)
    expect(textToFrame(frameToText(frame))).toEqual(frame)
  })

  it('writes only characters of the QR alphanumeric set', () => {
    const [frame] = encodeFrames({ kind: MessageKind.Payment, payload: bytes(300) }, limits)
    expect(frameToText(frame)).toMatch(/^[0-9A-Z $%*+\-./:]+$/)
  })

  it.each([
    ['a request with a 48-byte memo', 136, 1],
    ['a first payment', 387, 1],
    ['a first payment with 10 bytes of extensions', 397, 1],
  ])('keeps %s (%i bytes) within one frame text', (_, length) => {
    const frames = encodeFrames({ kind: MessageKind.Payment, payload: bytes(length) } as Message, limits)
    expect(frames).toHaveLength(1)
    expect(frameToText(frames[0]).length).toBeLessThanOrEqual(QR_CHARS.single)
  })

  it('keeps every frame of a longer message within the multi-frame text limit', () => {
    for (const length of [398, 760, 1136, 4144, 6400]) {
      const frames = encodeFrames({ kind: MessageKind.Payment, payload: bytes(length) }, limits)
      expect(frames.length).toBeGreaterThan(1)
      for (const frame of frames) expect(frameToText(frame).length).toBeLessThanOrEqual(QR_CHARS.multi)
    }
  })
})
