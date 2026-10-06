import type { ReceiveGate } from '../../payment/receive'
import { pointGate } from '../event/point'
import type { PointPairing } from '../event/payloads'
import { flaggedGate } from '../mesh/gossip'
import { meshNative } from '../mesh/native'
import type { NoteDb } from '../notes/db'
import { nowSeconds } from '../payment/payments-provider'

/** What a receiving phone checks before it keeps a payment: no flagged key in the chain, and at a point the event's own rules. */
export function receiveGate(
  db: NoteDb,
  point: { pairing: PointPairing } | null | undefined,
  noteDomain: Uint8Array,
): ReceiveGate {
  const flagged = flaggedGate(db)
  if (!point) return flagged
  const atPoint = pointGate(db, point.pairing, noteDomain, nowSeconds, (id, frame, ttl) =>
    meshNative.advertise(id, frame, ttl),
  )
  return {
    admit: async (received, bundle) => (await flagged.admit(received, bundle)) ?? atPoint.admit(received, bundle),
  }
}
