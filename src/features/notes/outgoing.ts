import { bytesToHex } from '@noble/hashes/utils.js'
import type { NoteDb } from './db'

export type PreparedPayment = {
  messageId: Uint8Array
  /** The issuer: this phone's device key. A lock sequence number is only unique within one key. */
  device: Uint8Array
  /** The first 8 bytes of the SHA-256 of the request, to tell when the same request is paid twice. */
  requestId: Uint8Array | null
  receiver: Uint8Array
  mint: Uint8Array
  amount: bigint
  lockSeq: number
  cumStart: bigint
  cumEnd: bigint
  expiry: number
  issueBody: Uint8Array
  ticket: Uint8Array
  memo: string | null
  transport: string | null
  now: number
}

export class IntervalTaken extends Error {
  constructor() {
    super('IntervalTaken')
  }
}

export async function nextCumEnd(db: NoteDb, device: Uint8Array, lockSeq: number): Promise<bigint> {
  const [row] = await db.all<{ next_cum_end: number }>(
    'SELECT next_cum_end FROM lock_cursor WHERE device = ? AND lock_seq = ?',
    [device, lockSeq],
  )
  return BigInt(row?.next_cum_end ?? 0)
}

/**
 * Before anything is signed: advances the lock's cursor from `cumStart` to `cumEnd` and stores the
 * unsigned issue, in one transaction. Fails with `IntervalTaken` when the cursor is not at `cumStart`.
 */
export async function preparePayment(db: NoteDb, p: PreparedPayment): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.all<{ next_cum_end: number }>(
      'SELECT next_cum_end FROM lock_cursor WHERE device = ? AND lock_seq = ?',
      [p.device, p.lockSeq],
    )
    if (BigInt(row?.next_cum_end ?? 0) !== p.cumStart) throw new IntervalTaken()
    await tx.run(
      'INSERT INTO lock_cursor (device, lock_seq, next_cum_end) VALUES (?, ?, ?) ON CONFLICT (device, lock_seq) DO UPDATE SET next_cum_end = excluded.next_cum_end',
      [p.device, p.lockSeq, Number(p.cumEnd)],
    )
    await tx.run(
      `INSERT INTO outgoing_payment (message_id, device, request_id, state, receiver, mint, amount, lock_seq, cum_start, cum_end, expiry, issue_body, ticket,
         memo, transport, created_at, updated_at) VALUES (?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        p.messageId,
        p.device,
        p.requestId,
        p.receiver,
        p.mint,
        Number(p.amount),
        p.lockSeq,
        Number(p.cumStart),
        Number(p.cumEnd),
        p.expiry,
        p.issueBody,
        p.ticket,
        p.memo,
        p.transport,
        p.now,
        p.now,
      ],
    )
  })
}

/** Right after signing: the signature and the exact bytes that will be shown. Idempotent for the same bytes. */
export async function markSigned(
  db: NoteDb,
  messageId: Uint8Array,
  signature: Uint8Array,
  bundle: Uint8Array,
  now: number,
) {
  await db.run(
    `UPDATE outgoing_payment SET state = 'signed', signature = COALESCE(signature, ?), bundle = COALESCE(bundle, ?), updated_at = ?
     WHERE message_id = ? AND state IN ('prepared', 'signed')`,
    [signature, bundle, now, messageId],
  )
}

export type OutgoingState = 'prepared' | 'signed' | 'confirmed' | 'rejected' | 'abandoned'
export async function setOutgoingState(
  db: NoteDb,
  messageId: Uint8Array,
  state: OutgoingState,
  now: number,
  reason: number | null = null,
) {
  await db.run('UPDATE outgoing_payment SET state = ?, reason = ?, updated_at = ? WHERE message_id = ?', [
    state,
    reason,
    now,
    messageId,
  ])
}

export type Unfinished = {
  messageId: Uint8Array
  state: 'prepared' | 'signed'
  issueBody: Uint8Array
  ticket: Uint8Array
  bundle: Uint8Array | null
}

/** Payments to resume after a restart: prepared (sign the same body again) or signed and not yet confirmed or rejected. */
export async function unfinishedPayments(db: NoteDb): Promise<Unfinished[]> {
  const rows = await db.all<{
    message_id: Uint8Array
    state: 'prepared' | 'signed'
    issue_body: Uint8Array
    ticket: Uint8Array
    bundle: Uint8Array | null
  }>(
    "SELECT message_id, state, issue_body, ticket, bundle FROM outgoing_payment WHERE state IN ('prepared', 'signed') ORDER BY created_at",
  )
  return rows.map((r) => ({
    messageId: r.message_id,
    state: r.state,
    issueBody: r.issue_body,
    ticket: r.ticket,
    bundle: r.bundle,
  }))
}

/** The payment already made for this request that is still alive (not rejected, not abandoned), if any. */
export async function paymentForRequest(
  db: NoteDb,
  requestId: Uint8Array,
): Promise<{ messageId: Uint8Array; state: OutgoingState } | undefined> {
  const [row] = await db.all<{ message_id: Uint8Array; state: OutgoingState }>(
    "SELECT message_id, state FROM outgoing_payment WHERE request_id = ? AND state IN ('prepared', 'signed', 'confirmed') LIMIT 1",
    [requestId],
  )
  return row && { messageId: row.message_id, state: row.state }
}

export type PaymentContext = {
  /** Hex of the keys of the phones this one has signed payments to. */
  knownReceivers: Set<string>
  /** What the person authorised since `since`, whatever came of it: the confirmation step counts it. */
  paidToday: bigint
  /** Hex of the request ids that have a live payment. */
  paidRequests: Set<string>
}

/** What `planPayment` asks of the journal: who was paid before, the day's total and the requests already paid. */
export async function paymentContext(db: NoteDb, since: number): Promise<PaymentContext> {
  const [known, total, requests] = await Promise.all([
    db.all<{ receiver: Uint8Array }>(
      "SELECT DISTINCT receiver FROM outgoing_payment WHERE state IN ('signed', 'confirmed', 'rejected')",
    ),
    db.all<{ total: number | null }>('SELECT SUM(amount) AS total FROM outgoing_payment WHERE created_at >= ?', [
      since,
    ]),
    db.all<{ request_id: Uint8Array }>(
      "SELECT DISTINCT request_id FROM outgoing_payment WHERE request_id IS NOT NULL AND state IN ('prepared', 'signed', 'confirmed')",
    ),
  ])
  return {
    knownReceivers: new Set(known.map((row) => bytesToHex(row.receiver))),
    paidToday: BigInt(total[0].total ?? 0),
    paidRequests: new Set(requests.map((row) => bytesToHex(row.request_id))),
  }
}
