import { GRACE } from '../../protocol'
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
  /** Phones nearby that took a held note to settle it for this phone, when it was handed over. */
  handedTo?: number | null
  /** A payment to someone far away, and the name of the contact it went to when this phone has one. */
  remote?: boolean
  payee?: string | null
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
    handed_to: number | null
    remote: number
    payee: string | null
  }>(
    `SELECT * FROM (
       SELECT p.message_id AS id, 'paid' AS kind, p.amount,
         CASE WHEN r.state IS NOT NULL THEN 'remote-' || r.state ELSE p.state END AS state,
         p.created_at AS at, p.receiver AS counterparty, p.memo, p.reason, r.stored_by AS handed_to,
         r.message_id IS NOT NULL AS remote, c.name AS payee
       FROM outgoing_payment p LEFT JOIN relay_outbox r ON r.message_id = p.message_id LEFT JOIN contacts c ON c.wallet = p.receiver
       UNION ALL
       SELECT received_note.message_id, 'received', amount,
         CASE WHEN transport = 'change' AND received_note.state = 'held' THEN 'change'
              WHEN received_note.state = 'held' AND o.ref IS NOT NULL THEN
                CASE WHEN o.answer IN ('submitted', 'duplicate') THEN 'relay-sent'
                     WHEN o.answer IS NULL AND o.stored_by > 0 THEN 'relay-handed'
                     ELSE 'relay-waiting' END
              ELSE received_note.state END,
         received_at, issuer, memo, NULL, o.stored_by, 0, NULL
       FROM received_note LEFT JOIN relay_outbox o ON o.ref = lower(hex(received_note.output_id))
     ) WHERE at < ? ORDER BY at DESC, kind LIMIT ?`,
    [before ?? Number.MAX_SAFE_INTEGER, limit],
  )
  return rows.map(({ handed_to: handedTo, remote, ...row }) => ({
    ...row,
    amount: BigInt(row.amount),
    handedTo,
    remote: remote === 1,
  }))
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
  /** A remote payment: where it stands and the last moment it can still be paid. */
  deadline?: number
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
      remote_state: string | null
      stored_by: number | null
      payee: string | null
    }>(
      `SELECT p.amount, p.state, p.created_at AS at, p.receiver, p.memo, p.reason, p.transport, p.expiry,
         r.state AS remote_state, r.stored_by, c.name AS payee
       FROM outgoing_payment p LEFT JOIN relay_outbox r ON r.message_id = p.message_id LEFT JOIN contacts c ON c.wallet = p.receiver
       WHERE p.message_id = ?`,
      [id],
    )
    if (!row) return undefined
    const remote = row.remote_state !== null
    return {
      id,
      kind,
      amount: BigInt(row.amount),
      state: remote ? `remote-${row.remote_state}` : row.state,
      at: row.at,
      counterparty: row.receiver,
      memo: row.memo,
      reason: row.reason,
      transport: row.transport,
      expiry: row.expiry,
      unfinished: !remote && (row.state === 'prepared' || row.state === 'signed'),
      ...(remote ? { remote, payee: row.payee, handedTo: row.stored_by, deadline: row.expiry + GRACE } : {}),
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
