import type { NoteDb } from './db'

export type ActivityRow = {
  id: Uint8Array
  kind: 'paid' | 'received'
  amount: bigint
  state: string
  at: number
  /** The other party's public key: the receiver of a payment made, the issuer of a note received. */
  counterparty: Uint8Array
  memo: string | null
  /** The receiver's reason for a payment that was refused. */
  reason: number | null
}

/** Payments made and notes received in one list, newest first. Nothing about anyone's bond or balance. */
export async function listActivity(db: NoteDb, limit: number, before?: number): Promise<ActivityRow[]> {
  const rows = await db.all<{
    id: Uint8Array
    kind: 'paid' | 'received'
    amount: number
    state: string
    at: number
    counterparty: Uint8Array
    memo: string | null
    reason: number | null
  }>(
    `SELECT * FROM (
       SELECT message_id AS id, 'paid' AS kind, amount, state, created_at AS at, receiver AS counterparty, memo, reason FROM outgoing_payment
       UNION ALL
       SELECT message_id, 'received', amount, CASE WHEN transport = 'change' AND state = 'held' THEN 'change' ELSE state END, received_at, issuer, memo, NULL FROM received_note
     ) WHERE at < ? ORDER BY at DESC, kind LIMIT ?`,
    [before ?? Number.MAX_SAFE_INTEGER, limit],
  )
  return rows.map((row) => ({ ...row, amount: BigInt(row.amount) }))
}

export type ActivityDetail = ActivityRow & {
  transport: string | null
  expiry: number
  /** A payment made that is still to be finished: prepared, or signed and not answered. */
  unfinished: boolean
  /** A note received: the output it is settled by, and the lock numbers that back it. */
  outputId?: Uint8Array
  locks?: number[]
  requestedAmount?: bigint | null
}

/** One row of the list with what its screen shows besides: how it was shown, when it ends, which locks back it. */
export async function activityDetail(
  db: NoteDb,
  kind: ActivityRow['kind'],
  id: Uint8Array,
): Promise<ActivityDetail | undefined> {
  if (kind === 'paid') {
    const [row] = await db.all<{
      amount: number
      state: string
      at: number
      receiver: Uint8Array
      memo: string | null
      reason: number | null
      transport: string | null
      expiry: number
    }>(
      'SELECT amount, state, created_at AS at, receiver, memo, reason, transport, expiry FROM outgoing_payment WHERE message_id = ?',
      [id],
    )
    if (!row) return undefined
    return {
      id,
      kind,
      amount: BigInt(row.amount),
      state: row.state,
      at: row.at,
      counterparty: row.receiver,
      memo: row.memo,
      reason: row.reason,
      transport: row.transport,
      expiry: row.expiry,
      unfinished: row.state === 'prepared' || row.state === 'signed',
    }
  }
  const [row] = await db.all<{
    output_id: Uint8Array
    amount: number
    state: string
    at: number
    issuer: Uint8Array
    memo: string | null
    transport: string | null
    expiry: number
    requested_amount: number | null
  }>(
    'SELECT output_id, amount, state, received_at AS at, issuer, memo, transport, expiry, requested_amount FROM received_note WHERE message_id = ?',
    [id],
  )
  if (!row) return undefined
  const locks = await db.all<{ lock_seq: number }>(
    'SELECT DISTINCT lock_seq FROM note_liability WHERE output_id = ? ORDER BY lock_seq',
    [row.output_id],
  )
  return {
    id,
    kind,
    amount: BigInt(row.amount),
    state: row.state,
    at: row.at,
    counterparty: row.issuer,
    memo: row.memo,
    reason: null,
    transport: row.transport,
    expiry: row.expiry,
    unfinished: false,
    outputId: row.output_id,
    locks: locks.map((lock) => lock.lock_seq),
    requestedAmount: row.requested_amount === null ? null : BigInt(row.requested_amount),
  }
}
