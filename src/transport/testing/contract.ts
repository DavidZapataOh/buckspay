import { describe, expect, it } from 'vitest'
import { type Message, MessageKind, type Transport, TransportError, type TransportEvent } from '../types'

const bytes = (length: number, seed: number) => Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 0xff)

async function failure(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

/**
 * Every transport must pass these, over a pair whose two sides face each other. The turns strictly
 * alternate, because a medium that shows a message (QR) holds one message at a time.
 */
export function describeTransportContract(name: string, makePair: () => [Transport, Transport]) {
  describe(`transport contract: ${name}`, () => {
    const pair = () => {
      const [a, b] = makePair()
      return { a, b, dispose: () => Promise.all([a.close(), b.close()]) }
    }

    it('delivers a message byte for byte, and the reply the same way', async () => {
      const { a, b, dispose } = pair()
      const request: Message = { kind: MessageKind.Request, payload: bytes(136, 1) }
      const payment: Message = { kind: MessageKind.Payment, payload: bytes(387, 2) }
      const first = b.receive({ timeoutMs: 5000 })
      await a.send(request)
      expect(await first).toEqual(request)
      const second = a.receive({ timeoutMs: 5000 })
      await b.send(payment)
      expect(await second).toEqual(payment)
      await dispose()
    })

    it('delivers a message that needs several frames or packets', async () => {
      const { a, b, dispose } = pair()
      const message: Message = { kind: MessageKind.Payment, payload: bytes(3000, 3) }
      const received = b.receive({ timeoutMs: 10000 })
      await a.send(message)
      expect(await received).toEqual(message)
      await dispose()
    })

    it('delivers an empty payload', async () => {
      const { a, b, dispose } = pair()
      const received = b.receive({ timeoutMs: 5000 })
      await a.send({ kind: MessageKind.Receipt, payload: new Uint8Array(0) })
      expect((await received).payload).toHaveLength(0)
      await dispose()
    })

    it('refuses a message above maxMessageBytes with TooLarge', async () => {
      const { a, dispose } = pair()
      const error = await failure(
        a.send({ kind: MessageKind.Payment, payload: new Uint8Array(a.capabilities.maxMessageBytes + 1) }),
      )
      expect(error).toBeInstanceOf(TransportError)
      expect((error as TransportError).code).toBe('TooLarge')
      expect(a.state).toBe('idle')
      await dispose()
    })

    it('accepts a message of exactly maxMessageBytes', async () => {
      const { a, b, dispose } = pair()
      const message: Message = { kind: MessageKind.Payment, payload: bytes(a.capabilities.maxMessageBytes, 4) }
      const received = b.receive({ timeoutMs: 20000 })
      await a.send(message)
      expect((await received).payload).toEqual(message.payload)
      await dispose()
    })

    it('drops a message of a kind that was not accepted and goes on waiting', async () => {
      const { a, b, dispose } = pair()
      const received = b.receive({ accept: [MessageKind.Payment], timeoutMs: 5000 })
      await a.send({ kind: MessageKind.Request, payload: bytes(10, 5) })
      await a.send({ kind: MessageKind.Payment, payload: bytes(20, 6) })
      expect((await received).kind).toBe(MessageKind.Payment)
      await dispose()
    })

    it('rejects receive with Timeout when nothing arrives', async () => {
      const { b, dispose } = pair()
      const error = await failure(b.receive({ timeoutMs: 20 }))
      expect((error as TransportError).code).toBe('Timeout')
      await dispose()
    })

    it('rejects receive with Cancelled when its signal aborts, and at once when already aborted', async () => {
      const { b, dispose } = pair()
      const controller = new AbortController()
      const pending = failure(b.receive({ signal: controller.signal }))
      controller.abort()
      expect(((await pending) as TransportError).code).toBe('Cancelled')
      expect(((await failure(b.receive({ signal: controller.signal }))) as TransportError).code).toBe('Cancelled')
      await dispose()
    })

    it('rejects a pending receive with Cancelled on close, and close is idempotent', async () => {
      const { b } = pair()
      const pending = failure(b.receive())
      await b.close()
      await b.close()
      expect(((await pending) as TransportError).code).toBe('Cancelled')
      expect(((await failure(b.receive())) as TransportError).code).toBe('Cancelled')
    })

    it('reports progress that ends complete, and stops reporting after unsubscribe', async () => {
      const { a, b, dispose } = pair()
      const events: TransportEvent[] = []
      const stop = b.subscribe((event) => events.push(event))
      const received = b.receive({ timeoutMs: 10000 })
      await a.send({ kind: MessageKind.Payment, payload: bytes(1500, 7) })
      await received
      const progress = events.filter((e) => e.type === 'progress' && e.direction === 'in')
      expect(progress.length).toBeGreaterThan(0)
      const last = progress.at(-1)
      expect(last && last.type === 'progress' && last.done).toBeGreaterThan(0)
      expect(last && last.type === 'progress' && last.done === last.total).toBe(true)
      stop()
      const seen = events.length
      const again = b.receive({ timeoutMs: 5000 })
      await a.send({ kind: MessageKind.Request, payload: bytes(5, 8) })
      await again
      expect(events).toHaveLength(seen)
      await dispose()
    })
  })
}
