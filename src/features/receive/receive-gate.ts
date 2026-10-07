import type { ReceiveGate } from '../../payment/receive'
import { pointGate } from '../event/point'
import type { PointPairing } from '../event/payloads'
import { flaggedGate } from '../mesh/gossip'
import { feeGate } from '../zk/fee-gate'
import { meshNative } from '../mesh/native'
import type { NoteDb } from '../notes/db'
import { nowSeconds } from '../payment/payments-provider'

const withFees = (first: ReceiveGate, second: ReceiveGate): ReceiveGate => ({
  admit: async (received, bundle) => (await first.admit(received, bundle)) ?? second.admit(received, bundle),
})

/** What a receiving phone checks before it keeps a payment: no flagged key in the chain, and at a point the event's own rules. */
export function receiveGate(
  db: NoteDb,
  point: { pairing: PointPairing } | null | undefined,
  noteDomain: Uint8Array,
  fees?: { fee: (mint: Uint8Array) => Promise<bigint | undefined>; expected: bigint },
): ReceiveGate {
  const flagged = fees ? withFees(flaggedGate(db), feeGate(fees)) : flaggedGate(db)
  if (!point) return flagged
  const atPoint = pointGate(db, point.pairing, noteDomain, nowSeconds, (id, frame, ttl) =>
    meshNative.advertise(id, frame, ttl),
  )
  return {
    admit: async (received, bundle) => (await flagged.admit(received, bundle)) ?? atPoint.admit(received, bundle),
  }
}
