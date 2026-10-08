import { describe, expect, it, vi } from 'vitest'
import { createLoopbackPair } from '../transport/testing/loopback'
import { MessageKind, type TransportError } from '../transport/types'
import { encodeRequest, type PaymentRequest } from './messages'
import { awaitRequest } from './scan'
import { MINT, party } from './testing/world'

const request: PaymentRequest = {
  owner: { type: 'device', key: party(2).key },
  mint: MINT,
  amount: 5_000_000n,
  now: 1_800_000_000,
  minWindow: 3600,
  minHops: 1,
  attesters: [7],
  memo: '',
  witness: 'none',
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('awaitRequest', () => {
  it('gives up with Timeout when nothing arrives within timeoutMs', async () => {
    vi.useFakeTimers()
    try {
      const [payer] = createLoopbackPair()
      const outcome = awaitRequest(payer, { onWrongCode: () => {}, timeoutMs: 30_000 }).catch(
        (error: TransportError) => error.code,
      )
      let settled = false
      void outcome.then(() => (settled = true))
      await vi.advanceTimersByTimeAsync(29_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await outcome).toBe('Timeout')
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns the request it scans', async () => {
    const [payer, shop] = createLoopbackPair()
    const waiting = awaitRequest(payer, { onWrongCode: () => {} })
    await tick()
    await shop.send({ kind: MessageKind.Request, payload: encodeRequest(request) })
    expect(await waiting).toEqual(request)
  })

  it('says so for a code of another kind or one that is not a request, and keeps waiting', async () => {
    const [payer, shop] = createLoopbackPair()
    const onWrongCode = vi.fn()
    const waiting = awaitRequest(payer, { onWrongCode })
    await tick()
    await shop.send({ kind: MessageKind.Payment, payload: new Uint8Array(10) })
    await tick()
    await shop.send({ kind: MessageKind.Request, payload: new Uint8Array(10) })
    await tick()
    expect(onWrongCode).toHaveBeenCalledTimes(2)
    await shop.send({ kind: MessageKind.Request, payload: encodeRequest(request) })
    expect(await waiting).toEqual(request)
  })

  it('stops when the screen is left', async () => {
    const [payer] = createLoopbackPair()
    const controller = new AbortController()
    const waiting = awaitRequest(payer, { signal: controller.signal, onWrongCode: () => {} })
    controller.abort()
    await expect(waiting).rejects.toThrow()
  })
})
