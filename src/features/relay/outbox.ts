import type { Beacon } from '../mesh/beacon'
import type { NoteDb } from '../notes/db'
import type { RemoteState } from '../remote/delivery'
import { applyEvent } from '../remote/track'
import { COPIES, handOff, type L2capLink, type Seen, spray } from './handoff'
import { type RelayAnswer, type SealedRelay, sealedFrom } from './seal'

/** Seconds before a payment is handed over again after a `retry` answer that gave no time. */
export const DEFAULT_RETRY = 600

export type OutboxRow = {
  id: Uint8Array
  kind: 'settle' | 'remote'
  /** What the message is about: the hex of the output a held note settles. */
  ref: string
  blob: Uint8Array
  secret: Uint8Array
  clusterTag: Uint8Array
  storedBy: number
  answer: RelayAnswer['status'] | null
  nextHandAt: number
  createdAt: number
  expiresAt: number
  /** Copies of a remote payment this phone still has to spray to carriers. */
  copiesLeft: number
  state: RemoteState | null
  messageId: Uint8Array | null
  /** What the record of the payment's output will hold once it is settled. */
  content: Uint8Array | null
  conflict: boolean
}

type Stored = {
  id: Uint8Array
  kind: 'settle' | 'remote'
  ref: string
  blob: Uint8Array
  secret: Uint8Array
  cluster_tag: Uint8Array
  stored_by: number
  answer: RelayAnswer['status'] | null
  next_hand_at: number
  created_at: number
  expires_at: number
  copies_left: number
  state: RemoteState | null
  message_id: Uint8Array | null
  content: Uint8Array | null
  conflict: number
}

const toRow = (row: Stored): OutboxRow => ({
  id: row.id,
  kind: row.kind,
  ref: row.ref,
  blob: row.blob,
  secret: row.secret,
  clusterTag: row.cluster_tag,
  storedBy: row.stored_by,
  answer: row.answer,
  nextHandAt: row.next_hand_at,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  copiesLeft: row.copies_left,
  state: row.state,
  messageId: row.message_id,
  content: row.content,
  conflict: row.conflict === 1,
})

/** Queues a sealed message about `ref` once: a second one about the same output is ignored. */
export async function queueSealed(
  db: NoteDb,
  {
    id,
    ref,
    sealed,
    now,
    expiresAt,
    remote,
  }: {
    id: Uint8Array
    ref: string
    sealed: SealedRelay
    now: number
    expiresAt: number
    /** A payment to someone far away: the payer's message, the content of its record and the copies to spray. */
    remote?: { messageId: Uint8Array; content: Uint8Array; copies: number }
  },
): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO relay_outbox (id, kind, ref, blob, secret, cluster_tag, stored_by, answer, next_hand_at, created_at, expires_at, copies_left, state, message_id, content)
     SELECT ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM relay_outbox WHERE ref = ?)`,
    [
      id,
      remote ? 'remote' : 'settle',
      ref,
      sealed.blob,
      sealed.secret,
      sealed.clusterTag,
      now,
      now,
      expiresAt,
      remote?.copies ?? 0,
      remote ? 'signed' : null,
      remote?.messageId ?? null,
      remote?.content ?? null,
      ref,
    ],
  )
}

export async function outboxFor(db: NoteDb, ref: string): Promise<OutboxRow | undefined> {
  const [row] = await db.all<Stored>('SELECT * FROM relay_outbox WHERE ref = ?', [ref])
  return row && toRow(row)
}

/** Messages to hand over now: none answered for good, not expired, and past their wait. */
export async function dueRows(db: NoteDb, now: number): Promise<OutboxRow[]> {
  const rows = await db.all<Stored>(
    `SELECT * FROM relay_outbox WHERE (answer IS NULL OR answer = 'retry') AND next_hand_at <= ? AND expires_at > ? ORDER BY created_at`,
    [now, now],
  )
  return rows.map(toRow)
}

/** Hands one row to the beacons in range and keeps what came back: how many phones took it, and its answer. */
export async function handOffRow(
  db: NoteDb,
  row: OutboxRow,
  beacons: readonly Seen<Beacon>[],
  link: L2capLink,
  now: number,
  random?: () => number,
): Promise<{ stored: number; answer: RelayAnswer | null }> {
  const sealed = sealedFrom(row.blob, row.secret, row.clusterTag)
  const result = await handOff(sealed, beacons, link, COPIES, random)
  const sprayed =
    row.kind === 'remote' && row.copiesLeft > 1 ? await spray(sealed, row.copiesLeft, beacons, link) : null
  const retry = result.answer?.status === 'retry' ? result.answer.retryAfter : DEFAULT_RETRY
  const wait = result.answer === null || result.answer.status === 'retry' ? now + retry : row.nextHandAt
  await db.run('UPDATE relay_outbox SET stored_by = ?, answer = ?, next_hand_at = ?, copies_left = ? WHERE id = ?', [
    Math.min(255, row.storedBy + result.stored + (sprayed?.stored ?? 0)),
    result.answer?.status ?? row.answer,
    wait,
    sprayed?.left ?? row.copiesLeft,
    row.id,
  ])
  if (row.kind === 'remote') {
    if (sprayed && sprayed.stored > 0) await applyEvent(db, row.ref, { type: 'stored', by: 'carrier', at: now }, now)
    if (result.stored > 0) await applyEvent(db, row.ref, { type: 'stored', by: 'relayer', at: now }, now)
    if (result.answer) await applyEvent(db, row.ref, { type: 'answer', answer: result.answer, at: now }, now)
  }
  return result
}
