import { describe, expect, it } from 'vitest'
import { encodeFrames } from '../framing'
import { describeTransportContract } from '../testing/contract'
import { createQrPair } from '../testing/qr-pair'
import { MessageKind } from '../types'
import { QrTransport } from './qr-transport'
import { qrFrameLimits } from './limits'
import { frameToText } from './text'

describeTransportContract('qr, no frames missed', () => createQrPair())
describeTransportContract('qr, half the frames missed', () => createQrPair({ drop: 0.5, seed: 7 }))

describe('QrTransport state', () => {
  it('is sending while a message is on screen, receiving while it waits to scan, idle once closed', async () => {
    const [a, b] = createQrPair()
    expect(a.state).toBe('idle')
    await a.send({ kind: MessageKind.Request, payload: new Uint8Array(10) })
    expect(a.state).toBe('sending')
    const pending = a.receive({ timeoutMs: 5000 })
    expect(a.state).toBe('receiving')
    await b.send({ kind: MessageKind.Receipt, payload: new Uint8Array(3) })
    await pending
    expect(a.state).toBe('sending')
    await a.close()
    expect(a.state).toBe('idle')
    await b.close()
  })

  it('shows every frame of a long message and clears the screen on close', async () => {
    const shown: (readonly string[])[] = []
    let cleared = 0
    const transport = new QrTransport({
      surface: { present: (texts) => shown.push(texts), clear: () => void cleared++ },
      scanner: { subscribe: () => () => {} },
    })
    await transport.send({ kind: MessageKind.Payment, payload: new Uint8Array(760) })
    expect(shown).toHaveLength(1)
    expect(shown[0]).toHaveLength(4)
    for (const text of shown[0]) expect(text.length).toBeLessThanOrEqual(311)
    await transport.send({ kind: MessageKind.Payment, payload: new Uint8Array(387) })
    expect(shown[1]).toHaveLength(1)
    expect(shown[1][0].length).toBeLessThanOrEqual(600)
    await transport.close()
    expect(cleared).toBeGreaterThan(0)
  })

  it('ignores texts that are not ours and keeps waiting', async () => {
    let emit: (text: string) => void = () => {}
    const transport = new QrTransport({
      surface: { present: () => {}, clear: () => {} },
      scanner: { subscribe: (listener) => ((emit = listener), () => {}) },
    })
    const received = transport.receive({ timeoutMs: 2000 })
    emit('https://example.com')
    emit('BP:not base45!')
    const [frame] = encodeFrames({ kind: MessageKind.Request, payload: Uint8Array.of(1, 2, 3) }, qrFrameLimits())
    emit(frameToText(frame))
    expect(await received).toEqual({ kind: MessageKind.Request, payload: Uint8Array.of(1, 2, 3) })
  })

  it('delivers the same message again when its code is scanned again', async () => {
    let emit: (text: string) => void = () => {}
    const transport = new QrTransport({
      surface: { present: () => {}, clear: () => {} },
      scanner: { subscribe: (listener) => ((emit = listener), () => {}) },
    })
    const [frame] = encodeFrames({ kind: MessageKind.Request, payload: Uint8Array.of(9) }, qrFrameLimits())
    for (let i = 0; i < 2; i++) {
      const received = transport.receive({ timeoutMs: 2000 })
      emit(frameToText(frame))
      expect((await received).payload).toEqual(Uint8Array.of(9))
    }
  })

  it('reports progress once per new frame and not for a frame it already has', async () => {
    let emit: (text: string) => void = () => {}
    const transport = new QrTransport({
      surface: { present: () => {}, clear: () => {} },
      scanner: { subscribe: (listener) => ((emit = listener), () => {}) },
    })
    const events: number[] = []
    transport.subscribe((event) => event.type === 'progress' && event.direction === 'in' && events.push(event.done))
    const frames = encodeFrames({ kind: MessageKind.Payment, payload: new Uint8Array(760) }, qrFrameLimits()).map(
      frameToText,
    )
    const received = transport.receive({ timeoutMs: 2000 })
    for (const text of [frames[0], frames[0], frames[0], frames[1], frames[1]]) emit(text)
    expect(events).toEqual([1, 2])
    for (const text of frames.slice(2)) emit(text)
    await received
    expect(events.at(-1)).toBe(frames.length)
  })
})
