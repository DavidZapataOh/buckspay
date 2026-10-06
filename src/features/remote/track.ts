import type { NoteDb } from '../notes/db'
import { nextState, type RemoteEvent, type RemoteState } from './delivery'

const FINAL: readonly RemoteState[] = ['delivered', 'expired', 'refused']

/** The row of a remote payment moves on an observed event; a payment that ends is marked so in the payer's ledger. */
export async function applyEvent(
  db: NoteDb,
  ref: string,
  event: RemoteEvent,
  now: number,
): Promise<RemoteState | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.all<{ state: RemoteState; message_id: Uint8Array }>(
      "SELECT state, message_id FROM relay_outbox WHERE ref = ? AND kind = 'remote'",
      [ref],
    )
    if (!row) return null
    const next = nextState(row.state, event)
    if (next === row.state) return next
    const conflicting =
      next === 'refused' &&
      (event.type === 'chain' ||
        (event.type === 'answer' && event.answer.status === 'refused' && event.answer.reason === 'conflict'))
    await tx.run('UPDATE relay_outbox SET state = ?, conflict = ? WHERE ref = ?', [next, conflicting ? 1 : 0, ref])
    if (FINAL.includes(next) && !conflicting) {
      await tx.run("UPDATE outgoing_payment SET state = ?, updated_at = ? WHERE message_id = ? AND state = 'signed'", [
        next === 'delivered' ? 'confirmed' : 'abandoned',
        now,
        row.message_id,
      ])
    }
    return next
  })
}

/**
 * What remote payments still hold of the payer's money: those not ended, and those refused over a conflict, which stay
 * until the other side is known. A `retry` and a `duplicate` never release it.
 */
export async function reservedAmount(db: NoteDb): Promise<bigint> {
  const [row] = await db.all<{ total: number | null }>(
    `SELECT SUM(o.amount) AS total FROM relay_outbox r JOIN outgoing_payment o ON o.message_id = r.message_id
     WHERE r.kind = 'remote' AND (r.state IN ('signed', 'received', 'relaying') OR (r.state = 'refused' AND r.conflict = 1))`,
  )
  return BigInt(row.total ?? 0)
}
