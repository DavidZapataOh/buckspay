import { describe, expect, it } from 'vitest'
import { describeTransportContract } from '../testing/contract'
import { type Message, MessageKind, TransportError } from '../types'
import { createNearbyTransport, QUEUE_LIMIT } from './transport'
import { FakeAir } from './testing/fake'

function pair() {
  const air = new FakeAir()
  const [a, b] = air.connectedPair()
  return {
    a,
    b,
    ta: createNearbyTransport({ endpointId: b.id, native: a }),
    tb: createNearbyTransport({ endpointId: a.id, native: b }),
  }
}

describeTransportContract('nearby', () => {
  const { ta, tb } = pair()
  return [ta, tb]
})

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff)
const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as TransportError).code

describe('the Nearby transport', () => {
  it('keeps a message that arrives before anyone asked for it, and gives it out once', async () => {
    const { ta, tb } = pair()
    await ta.send({ kind: MessageKind.Request, payload: bytes(50, 1) })
    await new Promise((r) => setTimeout(r, 10))
    expect((await tb.receive({ timeoutMs: 500 })).payload).toEqual(bytes(50, 1))
    expect(await code(tb.receive({ timeoutMs: 30 }))).toBe('Timeout')
  })

  it('hands over a message that landed before the transport was built', async () => {
    const air = new FakeAir()
    const [a, b] = air.connectedPair()
    const ta = createNearbyTransport({ endpointId: b.id, native: a })
    await ta.send({ kind: MessageKind.Request, payload: bytes(50, 1) })
    await new Promise((r) => setTimeout(r, 10))
    const tb = createNearbyTransport({ endpointId: a.id, native: b })
    expect((await tb.receive({ timeoutMs: 200 })).payload).toEqual(bytes(50, 1))
  })

  it('keeps messages in the order they were sent', async () => {
    const { ta, tb } = pair()
    for (const kind of [MessageKind.Request, MessageKind.Payment, MessageKind.Receipt])
      await ta.send({ kind, payload: bytes(5, kind) })
    await new Promise((r) => setTimeout(r, 10))
    const kinds: number[] = []
    for (let i = 0; i < 3; i++) kinds.push((await tb.receive({ timeoutMs: 500 })).kind)
    expect(kinds).toEqual([0, 1, 2])
  })

  it('puts a version and the kind in front of the payload and nothing else', async () => {
    const { a, b, ta } = pair()
    await ta.send({ kind: MessageKind.Payment, payload: bytes(387, 2) })
    const call = a.calls.find((c) => c.method === 'sendBytes')!
    expect(call.args).toEqual([b.id, 389])
  })

  it('reports Interrupted for a call pending when the other phone goes away, then Unavailable for every new call', async () => {
    const { a, b, ta, tb } = pair()
    const pending = code(tb.receive())
    await new Promise((r) => setTimeout(r, 5))
    a.drop(b.id)
    expect(await pending).toBe('Interrupted')
    expect(await code(tb.receive({ timeoutMs: 20 }))).toBe('Unavailable')
    expect(await code(ta.send({ kind: MessageKind.Request, payload: bytes(1, 1) }))).toBe('Unavailable')
  })

  it('refuses a second send or a second receive while one is running', async () => {
    const { ta, tb } = pair()
    const first = tb.receive({ timeoutMs: 100 })
    expect(await code(tb.receive({ timeoutMs: 100 }))).toBe('Busy')
    await ta.send({ kind: MessageKind.Request, payload: bytes(1, 1) })
    await first
    const one = ta.send({ kind: MessageKind.Payment, payload: bytes(5, 1) })
    expect(await code(ta.send({ kind: MessageKind.Payment, payload: bytes(5, 2) }))).toBe('Busy')
    await one
  })

  it('treats a payload that breaks the format as Malformed and drops the connection', async () => {
    for (const wire of [Uint8Array.of(), Uint8Array.of(1), Uint8Array.of(9, 0, 1), Uint8Array.of(1, 7, 1)]) {
      const { a, b, tb } = pair()
      const pending = code(tb.receive({ timeoutMs: 200 }))
      await new Promise((r) => setTimeout(r, 5))
      b.inject(a.id, wire)
      expect(await pending).toBe('Malformed')
      expect(b.calls.some((c) => c.method === 'disconnect')).toBe(true)
    }
  })

  it('treats a flood as Malformed: more than the queue holds is a broken peer', async () => {
    const { a, b, tb } = pair()
    for (let i = 0; i <= QUEUE_LIMIT; i++) b.inject(a.id, Uint8Array.of(1, 0, i))
    await new Promise((r) => setTimeout(r, 20))
    expect(await code(tb.receive({ timeoutMs: 100 }))).toBe('Unavailable')
  })

  it('close disconnects once, cancels what was pending, and the other phone sees the link go', async () => {
    const { b, ta, tb } = pair()
    const pending = code(tb.receive())
    await tb.close()
    expect(await pending).toBe('Cancelled')
    await tb.close()
    expect(b.calls.filter((c) => c.method === 'disconnect')).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 5))
    expect(await code(ta.send({ kind: MessageKind.Request, payload: bytes(1, 1) }))).toBe('Unavailable')
  })

  it('check() reflects Play services, permissions and Bluetooth', async () => {
    const air = new FakeAir()
    const a = air.phone({ bluetooth: false })
    const b = air.phone()
    a.link(b)
    expect(await createNearbyTransport({ endpointId: b.id, native: a }).check()).toEqual({
      ready: false,
      reason: 'disabled',
    })
  })

  it('declares what it carries', () => {
    const { ta } = pair()
    expect(ta.id).toBe('nearby')
    expect(ta.capabilities).toEqual({ maxMessageBytes: 8192, deliveryFeedback: true })
  })

  it('refuses a payload above the maximum before it touches the radio', async () => {
    const { a, ta } = pair()
    const message: Message = { kind: MessageKind.Payment, payload: new Uint8Array(8193) }
    expect(await code(ta.send(message))).toBe('TooLarge')
    expect(a.calls.some((c) => c.method === 'sendBytes')).toBe(false)
  })
})
