import type { Beacon } from '../mesh/beacon'
import type { NoteDb } from '../notes/db'
import { COPIES, handOff, type L2capLink, type Seen } from './handoff'
import { type RelayAnswer, type SealedRelay, sealedFrom } from './seal'

/** Seconds before a payment is handed over again after a `retry` answer that gave no time. */
export const DEFAULT_RETRY = 600

export type OutboxRow = {
  id: Uint8Array
  kind: 'settle'
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
}

type Stored = {
  id: Uint8Array
  kind: 'settle'
  ref: string
  blob: Uint8Array
  secret: Uint8Array
  cluster_tag: Uint8Array
  stored_by: number
  answer: RelayAnswer['status'] | null
  next_hand_at: number
  created_at: number
  expires_at: number
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
  }: { id: Uint8Array; ref: string; sealed: SealedRelay; now: number; expiresAt: number },
): Promise<void> {
  await db.run(
    `INSERT OR IGNORE INTO relay_outbox (id, kind, ref, blob, secret, cluster_tag, stored_by, answer, next_hand_at, created_at, expires_at)
     SELECT ?, 'settle', ?, ?, ?, ?, 0, NULL, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM relay_outbox WHERE ref = ?)`,
    [id, ref, sealed.blob, sealed.secret, sealed.clusterTag, now, now, expiresAt, ref],
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
  const result = await handOff(sealedFrom(row.blob, row.secret, row.clusterTag), beacons, link, COPIES, random)
  const retry = result.answer?.status === 'retry' ? result.answer.retryAfter : DEFAULT_RETRY
  const wait = result.answer === null || result.answer.status === 'retry' ? now + retry : row.nextHandAt
  await db.run('UPDATE relay_outbox SET stored_by = ?, answer = ?, next_hand_at = ? WHERE id = ?', [
    Math.min(255, row.storedBy + result.stored),
    result.answer?.status ?? row.answer,
    wait,
    row.id,
  ])
  return result
}
