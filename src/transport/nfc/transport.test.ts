import { describe, expect, it } from 'vitest'
import { describeTransportContract } from '../testing/contract'
import { MessageKind, TransportError } from '../types'
import { FakeNfc } from './testing/fake'
import { createNfcTransport } from './transport'
import { NfcNativeError } from './types'

const pair = () => {
  const [a, b] = FakeNfc.pair()
  return { a, b, ta: createNfcTransport(a), tb: createNfcTransport(b) }
}
const code = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as TransportError).code
const bytes = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 5 + seed) & 0xff)

describeTransportContract('nfc', () => {
  const { ta, tb } = pair()
  return [ta, tb]
})

describe('the NFC transport', () => {
  it('declares what it carries', () => {
    const { ta } = pair()
    expect([ta.id, ta.capabilities]).toEqual(['nfc', { maxMessageBytes: 8192, deliveryFeedback: true }])
  })

  it('becomes the card when its first call is send and the reader when it is receive', async () => {
    const { a, b, ta, tb } = pair()
    const got = tb.receive({ timeoutMs: 500 })
    await ta.send({ kind: MessageKind.Request, payload: bytes(10, 1) })
    await got
    expect([a.role, b.role]).toEqual(['card', 'reader'])
  })

  it('can be told its role, for a flow that must be the reader and send first', async () => {
    const [a, b] = FakeNfc.pair()
    const reader = createNfcTransport(a, 'reader')
    const card = createNfcTransport(b, 'card')
    const got = card.receive({ timeoutMs: 500 })
    await reader.send({ kind: MessageKind.Payment, payload: bytes(387, 2) })
    expect((await got).payload).toEqual(bytes(387, 2))
    expect([a.role, b.role]).toEqual(['reader', 'card'])
  })

  it('keeps one role per instance and refuses a second instance while one holds the module', async () => {
    const { a } = pair()
    const abort = new AbortController()
    const first = createNfcTransport(a).send(
      { kind: MessageKind.Request, payload: bytes(1, 1) },
      { signal: abort.signal },
    )
    await new Promise((r) => setTimeout(r, 5))
    expect(await code(createNfcTransport(a).receive({ timeoutMs: 50 }))).toBe('Busy')
    abort.abort()
    expect(await code(first)).toBe('Cancelled')
  })

  it('maps what the module reports: a tear is Interrupted, a broken peer Malformed', async () => {
    const { a, ta } = pair()
    a.failNextReceive = new NfcNativeError('Interrupted')
    expect(await code(ta.receive({ timeoutMs: 100 }))).toBe('Interrupted')
    a.failNextReceive = new NfcNativeError('Malformed')
    expect(await code(ta.receive({ timeoutMs: 100 }))).toBe('Malformed')
  })

  it('cancels the native operation when the signal aborts, so a later call is not blocked', async () => {
    const { ta, tb } = pair()
    const abort = new AbortController()
    const pending = code(ta.send({ kind: MessageKind.Request, payload: bytes(5, 1) }, { signal: abort.signal }))
    abort.abort()
    expect(await pending).toBe('Cancelled')
    const got = tb.receive({ timeoutMs: 60 })
    expect(await code(got)).toBe('Timeout')
    const again = ta.send({ kind: MessageKind.Request, payload: bytes(5, 2) })
    expect((await tb.receive({ timeoutMs: 500 })).payload).toEqual(bytes(5, 2))
    await again
  })

  it('check() says what is missing: no NFC, no card emulation, switched off, or ready', async () => {
    const { a, ta } = pair()
    a.support_ = { hardware: false, hce: false, enabled: false, reader: false }
    expect(await ta.check()).toEqual({ ready: false, reason: 'hardware-missing' })
    a.support_ = { hardware: true, hce: false, enabled: true, reader: true }
    expect(await ta.check()).toEqual({ ready: false, reason: 'unsupported' })
    a.support_ = { hardware: true, hce: true, enabled: false, reader: true }
    expect(await ta.check()).toEqual({ ready: false, reason: 'disabled' })
    a.support_ = { hardware: true, hce: true, enabled: true, reader: true }
    expect(await ta.check()).toEqual({ ready: true })
  })

  it('a reader needs the reader option; a card does not', async () => {
    const [a, b] = FakeNfc.pair()
    a.support_ = b.support_ = { hardware: true, hce: true, enabled: true, reader: false }
    expect(await createNfcTransport(a, 'reader').check()).toEqual({ ready: false, reason: 'disabled' })
    expect(await createNfcTransport(b, 'card').check()).toEqual({ ready: true })
  })

  it('close releases the module and a new transport can take it', async () => {
    const { a, ta } = pair()
    const pending = code(ta.send({ kind: MessageKind.Request, payload: bytes(1, 1) }))
    await new Promise((r) => setTimeout(r, 5))
    await ta.close()
    expect(await pending).toBe('Cancelled')
    expect(a.role).toBeUndefined()
    await createNfcTransport(a)
      .receive({ timeoutMs: 20 })
      .catch(() => {})
    expect(a.role).toBe('reader')
  })
})
