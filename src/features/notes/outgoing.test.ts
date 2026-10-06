import { bytesToHex } from '@noble/hashes/utils.js'
import { beforeEach, describe, expect, it } from 'vitest'
import type { NoteDb } from './db'
import {
  IntervalTaken,
  markSigned,
  nextCumEnd,
  paymentContext,
  paymentForRequest,
  type PreparedPayment,
  preparePayment,
  setOutgoingState,
  unfinishedPayments,
} from './outgoing'
import { reconcileIdentity } from './ledger'
import { migrate } from './schema'
import { createNodeDb } from './testing/node-db'

const bytes = (n: number, length = 32) => new Uint8Array(length).fill(n)
const DEVICE = bytes(11, 33)
function payment(over: Partial<PreparedPayment> = {}): PreparedPayment {
  return {
    messageId: bytes(1),
    device: bytes(11, 33),
    requestId: bytes(12, 8),
    receiver: bytes(2, 33),
    mint: bytes(3),
    amount: 5_000_000n,
    lockSeq: 3,
    cumStart: 0n,
    cumEnd: 5_000_000n,
    expiry: 2_000_000_000,
    issueBody: bytes(4, 163),
    ticket: bytes(5, 161),
    memo: null,
    transport: 'qr',
    now: 1_000,
    ...over,
  }
}

let db: NoteDb
beforeEach(async () => {
  db = createNodeDb()
  await migrate(db)
})

describe('preparePayment', () => {
  it('starts every lock at zero and moves the cursor with the stored issue, together', async () => {
    expect(await nextCumEnd(db, DEVICE, 3)).toBe(0n)
    await preparePayment(db, payment())
    expect(await nextCumEnd(db, DEVICE, 3)).toBe(5_000_000n)
    const [row] = await db.all<{ state: string; issue_body: Uint8Array }>(
      'SELECT state, issue_body FROM outgoing_payment',
    )
    expect(row.state).toBe('prepared')
    expect(row.issue_body).toEqual(bytes(4, 163))
  })

  it('refuses an interval that does not start at the cursor and leaves everything as it was', async () => {
    await preparePayment(db, payment())
    await expect(preparePayment(db, payment({ messageId: bytes(9), cumStart: 0n, cumEnd: 1n }))).rejects.toBeInstanceOf(
      IntervalTaken,
    )
    await expect(
      preparePayment(db, payment({ messageId: bytes(9), cumStart: 9n, cumEnd: 10n })),
    ).rejects.toBeInstanceOf(IntervalTaken)
    expect(await nextCumEnd(db, DEVICE, 3)).toBe(5_000_000n)
    expect(await db.all('SELECT 1 FROM outgoing_payment')).toHaveLength(1)
  })

  it('does not move the cursor when storing the issue fails', async () => {
    db = createNodeDb((sql) => sql.includes('INSERT INTO outgoing_payment'))
    await migrate(db)
    await expect(preparePayment(db, payment())).rejects.toThrow('injected failure')
    expect(await nextCumEnd(db, DEVICE, 3)).toBe(0n)
  })

  it('lets two locks advance independently', async () => {
    await preparePayment(db, payment())
    await preparePayment(db, payment({ messageId: bytes(8), lockSeq: 4, cumStart: 0n, cumEnd: 7n }))
    expect(await nextCumEnd(db, DEVICE, 3)).toBe(5_000_000n)
    expect(await nextCumEnd(db, DEVICE, 4)).toBe(7n)
  })
})

describe('recovery after a restart', () => {
  it('lists a prepared payment with the exact body to sign again', async () => {
    await preparePayment(db, payment())
    expect(await unfinishedPayments(db)).toEqual([
      {
        messageId: bytes(1),
        input: null,
        state: 'prepared',
        issueBody: bytes(4, 163),
        ticket: bytes(5, 161),
        bundle: null,
      },
    ])
  })

  it('keeps the first signature and bundle when signing is recorded twice', async () => {
    await preparePayment(db, payment())
    await markSigned(db, bytes(1), bytes(6, 64), bytes(7, 391), 2_000)
    await markSigned(db, bytes(1), bytes(8, 64), bytes(9, 391), 3_000)
    const [row] = await db.all<{ signature: Uint8Array; bundle: Uint8Array; state: string }>(
      'SELECT signature, bundle, state FROM outgoing_payment',
    )
    expect(row.state).toBe('signed')
    expect(row.signature).toEqual(bytes(6, 64))
    expect(row.bundle).toEqual(bytes(7, 391))
    expect((await unfinishedPayments(db))[0].bundle).toEqual(bytes(7, 391))
  })

  it('stops listing a payment once it is confirmed, rejected or abandoned, and never moves the cursor back', async () => {
    for (const [n, state] of [
      [1, 'confirmed'],
      [2, 'rejected'],
      [3, 'abandoned'],
    ] as const) {
      await preparePayment(db, payment({ messageId: bytes(n), cumStart: BigInt((n - 1) * 10), cumEnd: BigInt(n * 10) }))
      await setOutgoingState(db, bytes(n), state, 5)
    }
    expect(await unfinishedPayments(db)).toEqual([])
    expect(await nextCumEnd(db, DEVICE, 3)).toBe(30n)
  })

  it("records the receiver's reason when a payment is rejected", async () => {
    await preparePayment(db, payment())
    await setOutgoingState(db, bytes(1), 'rejected', 5, 10)
    expect((await db.all<{ reason: number }>('SELECT reason FROM outgoing_payment'))[0].reason).toBe(10)
  })
})

describe('one lock number on two identities', () => {
  it('keeps a separate cursor per device key, so a new identity starts at zero without touching the old one', async () => {
    await preparePayment(db, payment())
    const other = bytes(21, 33)
    expect(await nextCumEnd(db, other, 3)).toBe(0n)
    await preparePayment(db, payment({ messageId: bytes(9), device: other, requestId: null }))
    expect(await nextCumEnd(db, DEVICE, 3)).toBe(5_000_000n)
    expect(await nextCumEnd(db, other, 3)).toBe(5_000_000n)
  })
})

describe('paymentForRequest', () => {
  it('finds a live payment for the same request and ignores rejected and abandoned ones', async () => {
    expect(await paymentForRequest(db, bytes(12, 8))).toBeUndefined()
    await preparePayment(db, payment())
    expect(await paymentForRequest(db, bytes(12, 8))).toEqual({ messageId: bytes(1), state: 'prepared' })
    await setOutgoingState(db, bytes(1), 'rejected', 5, 10)
    expect(await paymentForRequest(db, bytes(12, 8))).toBeUndefined()
    await preparePayment(db, payment({ messageId: bytes(2), cumStart: 5_000_000n, cumEnd: 6_000_000n }))
    await setOutgoingState(db, bytes(2), 'confirmed', 6)
    expect(await paymentForRequest(db, bytes(12, 8))).toEqual({ messageId: bytes(2), state: 'confirmed' })
    expect(await paymentForRequest(db, bytes(13, 8))).toBeUndefined()
  })
})

describe('an identity reset', () => {
  it('leaves a payment of the old key unfinished until the store is reconciled with the current key', async () => {
    await preparePayment(db, payment())
    expect(await unfinishedPayments(db)).toHaveLength(1)
    await reconcileIdentity(db, bytes(99, 33), 50)
    expect(await unfinishedPayments(db)).toEqual([])
    expect((await db.all<{ state: string }>('SELECT state FROM outgoing_payment'))[0].state).toBe('abandoned')
    await preparePayment(
      db,
      payment({ messageId: bytes(7), device: bytes(99, 33), cumStart: 0n, cumEnd: 5n, requestId: null }),
    )
    expect(await unfinishedPayments(db)).toHaveLength(1)
  })
})

describe('paymentContext', () => {
  it('knows who was paid, what was authorised since a time and which requests have a live payment', async () => {
    await preparePayment(db, payment({ messageId: bytes(1), requestId: bytes(12, 8), now: 100 }))
    await markSigned(db, bytes(1), bytes(6, 64), bytes(7, 391), 101)
    await preparePayment(
      db,
      payment({
        messageId: bytes(2),
        requestId: bytes(13, 8),
        receiver: bytes(3, 33),
        cumStart: 5_000_000n,
        cumEnd: 8_000_000n,
        amount: 3_000_000n,
        now: 900,
      }),
    )
    const context = await paymentContext(db, 500)
    expect(context.paidToday).toBe(3_000_000n)
    expect(context.knownReceivers).toEqual(new Set([bytesToHex(bytes(2, 33))]))
    expect(context.paidRequests).toEqual(new Set([bytesToHex(bytes(12, 8)), bytesToHex(bytes(13, 8))]))
    expect((await paymentContext(db, 0)).paidToday).toBe(8_000_000n)
    expect((await paymentContext(db, 900)).paidToday).toBe(3_000_000n)
    expect((await paymentContext(db, 901)).paidToday).toBe(0n)
  })

  it('stops knowing a request once its payment was refused or cancelled, and a receiver that was never signed for', async () => {
    await preparePayment(db, payment({ messageId: bytes(1), requestId: bytes(12, 8) }))
    await markSigned(db, bytes(1), bytes(6, 64), bytes(7, 391), 101)
    await setOutgoingState(db, bytes(1), 'rejected', 102, 11)
    const context = await paymentContext(db, 0)
    expect(context.paidRequests).toEqual(new Set())
    expect(context.knownReceivers).toEqual(new Set([bytesToHex(bytes(2, 33))]))
    await preparePayment(
      db,
      payment({ messageId: bytes(2), receiver: bytes(4, 33), cumStart: 5_000_000n, cumEnd: 6_000_000n, amount: 1n }),
    )
    expect((await paymentContext(db, 0)).knownReceivers).toEqual(new Set([bytesToHex(bytes(2, 33))]))
  })
})
