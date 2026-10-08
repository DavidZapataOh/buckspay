import { describe, expect, it, vi } from 'vitest'
import { describeTransportContract } from '../testing/contract'
import { type Message, MessageKind, TransportError } from '../types'
import { createNearbyTransport, NEARBY_WAIT_MS, QUEUE_LIMIT } from './transport'
import { FakeAir } from './testing/fake'

function pair() {
  const air = new FakeAir()
  const [a, b] = air.connectedPair()
  return {
    a,
    b,
    ta: createNearbyTransport({ endpointId: b.id, native: a, role: 'receiver' }),
    tb: createNearbyTransport({ endpointId: a.id, native: b, role: 'payer' }),
  }
}

describeTransportContract('nearby', () => {
  const { ta, tb } = pair()
  return [ta, tb]
})

const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff)
const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as TransportError).code

const sentTo = (phone: { calls: { method: string; args: unknown[] }[] }, size?: number) =>
  phone.calls.filter((c) => c.method === 'sendBytes' && (size === undefined || c.args[1] === size))

/** A send over the fake air takes a timer tick, so under fake timers it has to be driven. */
async function sendNow(transport: { send(message: Message): Promise<void> }, message: Message) {
  const sent = transport.send(message)
  await vi.advanceTimersByTimeAsync(10)
  await sent
}

describe('the Nearby link handshake', () => {
  it('has the payer say it is ready as soon as its transport exists', () => {
    const air = new FakeAir()
    const [a, b] = air.connectedPair()
    createNearbyTransport({ endpointId: a.id, native: b, role: 'payer' })
    expect(sentTo(b, 2)).toHaveLength(1)
  })

  it('holds the receiver’s request until the payer is ready, then sends it', async () => {
    const air = new FakeAir()
    const [a, b] = air.connectedPair()
    const ta = createNearbyTransport({ endpointId: b.id, native: a, role: 'receiver' })
    const sent = ta.send({ kind: MessageKind.Request, payload: bytes(90, 1) })
    await new Promise((r) => setTimeout(r, 20))
    expect(sentTo(a)).toHaveLength(0)
    const tb = createNearbyTransport({ endpointId: a.id, native: b, role: 'payer' })
    await sent
    expect((await tb.receive({ timeoutMs: 200 })).payload).toEqual(bytes(90, 1))
  })

  it('gives up with Timeout when the payer never says it is ready', async () => {
    vi.useFakeTimers()
    try {
      const air = new FakeAir()
      const [a, b] = air.connectedPair()
      const ta = createNearbyTransport({ endpointId: b.id, native: a, role: 'receiver' })
      const outcome = ta.send({ kind: MessageKind.Request, payload: bytes(9, 1) }).catch((e: TransportError) => e.code)
      await vi.advanceTimersByTimeAsync(NEARBY_WAIT_MS)
      expect(await outcome).toBe('Timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-sends the request every 3 seconds until the payer answers, within the wait budget', async () => {
    vi.useFakeTimers()
    try {
      const air = new FakeAir()
      const [a, b] = air.connectedPair()
      const ta = createNearbyTransport({ endpointId: b.id, native: a, role: 'receiver' })
      const tb = createNearbyTransport({ endpointId: a.id, native: b, role: 'payer' })
      await vi.advanceTimersByTimeAsync(10)
      await sendNow(ta, { kind: MessageKind.Request, payload: bytes(90, 1) })
      expect(sentTo(a, 92)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(sentTo(a, 92)).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(NEARBY_WAIT_MS * 2)
      expect(sentTo(a, 92).length).toBeLessThanOrEqual(11)
      const before = sentTo(a, 92).length
      await vi.advanceTimersByTimeAsync(NEARBY_WAIT_MS)
      expect(sentTo(a, 92)).toHaveLength(before)
      await tb.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops re-sending once the payer answers', async () => {
    vi.useFakeTimers()
    try {
      const air = new FakeAir()
      const [a, b] = air.connectedPair()
      const ta = createNearbyTransport({ endpointId: b.id, native: a, role: 'receiver' })
      const tb = createNearbyTransport({ endpointId: a.id, native: b, role: 'payer' })
      await vi.advanceTimersByTimeAsync(10)
      await sendNow(ta, { kind: MessageKind.Request, payload: bytes(90, 1) })
      await vi.advanceTimersByTimeAsync(10)
      await tb.receive({ timeoutMs: 100 })
      await sendNow(tb, { kind: MessageKind.Payment, payload: bytes(20, 2) })
      await vi.advanceTimersByTimeAsync(10)
      const count = sentTo(a, 92).length
      await vi.advanceTimersByTimeAsync(NEARBY_WAIT_MS)
      expect(sentTo(a, 92)).toHaveLength(count)
    } finally {
      vi.useRealTimers()
    }
  })

  it('hands the payer one copy of a request that was sent twice', async () => {
    vi.useFakeTimers()
    try {
      const air = new FakeAir()
      const [a, b] = air.connectedPair()
      const ta = createNearbyTransport({ endpointId: b.id, native: a, role: 'receiver' })
      const tb = createNearbyTransport({ endpointId: a.id, native: b, role: 'payer' })
      await vi.advanceTimersByTimeAsync(10)
      await sendNow(ta, { kind: MessageKind.Request, payload: bytes(90, 1) })
      await vi.advanceTimersByTimeAsync(3_100)
      expect(sentTo(a, 92)).toHaveLength(2)
      expect((await tb.receive({ timeoutMs: 100 })).payload).toEqual(bytes(90, 1))
      const second = tb.receive({ timeoutMs: 100 }).catch((e: TransportError) => e.code)
      await vi.advanceTimersByTimeAsync(200)
      expect(await second).toBe('Timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('has the receiver ignore a repeated ready, and the payer stop saying it once it hears back', async () => {
    vi.useFakeTimers()
    try {
      const air = new FakeAir()
      const [a, b] = air.connectedPair()
      const ta = createNearbyTransport({ endpointId: b.id, native: a, role: 'receiver' })
      createNearbyTransport({ endpointId: a.id, native: b, role: 'payer' })
      await vi.advanceTimersByTimeAsync(7_000)
      expect(sentTo(b, 2).length).toBeGreaterThanOrEqual(3)
      const wait = ta.receive({ timeoutMs: 100 }).catch((e: TransportError) => e.code)
      await vi.advanceTimersByTimeAsync(200)
      expect(await wait).toBe('Timeout')
      await sendNow(ta, { kind: MessageKind.Request, payload: bytes(9, 1) })
      await vi.advanceTimersByTimeAsync(10)
      const count = sentTo(b, 2).length
      await vi.advanceTimersByTimeAsync(NEARBY_WAIT_MS)
      expect(sentTo(b, 2)).toHaveLength(count)
    } finally {
      vi.useRealTimers()
    }
  })
})

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
    const ta = createNearbyTransport({ endpointId: b.id, native: a, role: 'payer' })
    await ta.send({ kind: MessageKind.Payment, payload: bytes(50, 1) })
    await new Promise((r) => setTimeout(r, 10))
    const tb = createNearbyTransport({ endpointId: a.id, native: b, role: 'receiver' })
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
    expect(await createNearbyTransport({ endpointId: b.id, native: a, role: 'receiver' }).check()).toEqual({
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
