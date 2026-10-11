import { afterEach, describe, expect, it, vi } from 'vitest'
import { receivePayment } from '../../payment/receive-flow'
import { awaitReceipt, type PayDeps, type SentPayment } from '../../payment/pay'
import { createLoopbackPair } from '../../transport/testing/loopback'
import { type TransportError } from '../../transport/types'
import { untilExpiry, waitBudget, receiptBudget } from './wait-budget'

afterEach(() => vi.useRealTimers())

describe('waitBudget', () => {
  it('bounds the payer wait on Nearby and leaves the other media to their own timers', () => {
    expect(waitBudget('nearby')).toBe(30_000)
    expect(waitBudget('qr')).toBeUndefined()
    expect(waitBudget('nfc')).toBeUndefined()
  })

  it('gives the receipt a minute on Nearby', () => {
    expect(receiptBudget('nearby')).toBe(60_000)
    expect(receiptBudget('qr')).toBeUndefined()
  })
})

describe('untilExpiry', () => {
  it('is the time left of the request, never negative, and none for a medium with its own timer', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    expect(untilExpiry('nearby', 1_000 + 600)).toBe(600_000)
    expect(untilExpiry('nearby', 1_000 - 5)).toBe(0)
    expect(untilExpiry('qr', 1_600)).toBeUndefined()
  })

  it('keeps the receiver waiting for the payment at 45 seconds and at 5 minutes, and ends at the expiry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const [receiver] = createLoopbackPair()
    const expiresAt = 1_000 + 600
    const outcome = receivePayment(
      vi.fn(async () => ({}) as never),
      receiver,
      { timeoutMs: untilExpiry('nearby', expiresAt) },
    ).then(
      () => 'paid',
      (error: TransportError) => error.code,
    )
    let settled: unknown
    void outcome.then((value) => (settled = value))
    await vi.advanceTimersByTimeAsync(45_000)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(255_000)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(299_999)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe('Timeout')
  })

  it('bounds the payer wait for the receipt', async () => {
    vi.useFakeTimers()
    const [payer] = createLoopbackPair()
    const payment = { messageId: new Uint8Array(32), bundle: new Uint8Array(4), amount: 1n } as SentPayment
    const outcome = awaitReceipt(payment, { transport: payer } as PayDeps, {
      timeoutMs: receiptBudget('nearby'),
    }).catch((error: TransportError) => error.code)
    let settled: unknown
    void outcome.then((value) => (settled = value))
    await vi.advanceTimersByTimeAsync(59_999)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe('Timeout')
  })
})
