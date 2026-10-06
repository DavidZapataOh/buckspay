import { sha256 } from '@noble/hashes/sha2.js'
import type { Beacon } from '../mesh/beacon'
import type { NoteDb } from '../notes/db'
import { answeredByRelayer, toHand } from './carry'
import { handOff, type L2capLink, type Seen, toCarrier } from './handoff'
import { dueRows, handOffRow } from './outbox'
import type { SealedRelay } from './seal'

/** A blob this phone carries for someone else: it cannot read the answer, so it keeps none. */
const carried = (blob: Uint8Array, clusterTag: Uint8Array): SealedRelay => ({
  blob,
  clusterTag,
  secret: new Uint8Array(32),
  openResponse: async () => null,
})

/**
 * One pass over what waits to leave this phone: its own messages go to relayers (and, for remote payments, copies to
 * carriers), and what it carries for others goes to a relayer in range, or half its copies to another carrier.
 */
export async function runHandoffs({
  db,
  link,
  clusterTag,
  beacons,
  now,
}: {
  db: NoteDb
  link: L2capLink
  clusterTag: Uint8Array
  beacons: readonly Seen<Beacon>[]
  now: number
}): Promise<void> {
  for (const row of await dueRows(db, now)) await handOffRow(db, row, beacons, link, now)
  const online = beacons.some((b) => b.value.online)
  for (const blob of await toHand(db, { online }, now)) {
    if (online) {
      const { stored } = await handOff(carried(blob.blob, clusterTag), beacons, link, 1)
      if (stored > 0) await answeredByRelayer(db, blob.id, now)
    } else {
      const target = beacons.find((b) => !b.value.online)
      if (target) await toCarrier(blob.blob, blob.copies, target, link)
    }
  }
}

export const idOf = (blob: Uint8Array) => sha256(blob)
