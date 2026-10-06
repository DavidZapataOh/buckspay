import type { GetAccountInfoApi, GetBlockTimeApi, Rpc } from '@solana/kit'
import type { NoteDb } from '../notes/db'
import { outboxFor } from '../relay/outbox'
import { checkDelivery } from './delivery'
import { applyEvent } from './track'

/**
 * Reads the record of every remote payment that has not ended and moves it by what the cluster says. A payment whose
 * read fails is left as it is: nothing here ever ends one on a guess. Returns how many were read.
 */
export async function refreshDeliveries(
  db: NoteDb,
  rpc: Rpc<GetAccountInfoApi & GetBlockTimeApi>,
  program: Uint8Array,
  now: number,
): Promise<number> {
  const open = await db.all<{ ref: string }>(
    "SELECT ref FROM relay_outbox WHERE kind = 'remote' AND state IN ('signed', 'received', 'relaying')",
  )
  let read = 0
  for (const { ref } of open) {
    const row = await outboxFor(db, ref)
    if (!row) continue
    try {
      await applyEvent(db, ref, await checkDelivery(rpc, row, program), now)
      read++
    } catch {
      continue
    }
  }
  return read
}
