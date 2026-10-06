import { encodeSpendConflict, type Attester, type Receiver, type SpendConflict } from '../../protocol'
import { acceptancePolicy, AttesterLedger } from '../attesters'
import type { PaymentDomains } from '../payment/receiver'
import { Reason } from '../../payment/reasons'
import type { ReceiveGate } from '../../payment/receive'
import { MIN_WINDOW } from '../pay/limits'
import { relianceByAttester } from '../notes/ledger'
import type { NoteDb } from '../notes/db'
import { checkAtPoint, type PointCheck, recordAtPoint } from './consumed'
import { acceptConflict, recordConflict } from '../mesh/gossip'
import { passOn } from '../mesh/handlers'
import type { PointPairing } from './payloads'

const REFUSAL = {
  DoubleSpent: Reason.DoubleSpend,
  KeyBlocked: Reason.DoubleSpend,
  NotThisEvent: Reason.NotForYou,
  IssuerNotListed: Reason.Scope,
} as const satisfies Record<Extract<PointCheck, { ok: false }>['reason'], Reason>

/** The receiver of a point: it is the organiser's account, so it accepts the credit that names that account. */
export async function pointReceiverOf(
  db: NoteDb,
  domains: PaymentDomains,
  pairing: PointPairing,
  attesters: readonly Attester[],
  now: number,
): Promise<Receiver> {
  const ledger = AttesterLedger.fromJSON(await relianceByAttester(db))
  return acceptancePolicy({
    ...domains,
    me: { type: 'account', address: pairing.authority },
    now,
    attesters: ledger.apply([...attesters]),
    minWindow: MIN_WINDOW,
  })
}

/** The key a point proved to have spent twice is flagged, and the proof is passed on. */
async function flagAtPoint(
  db: NoteDb,
  noteDomain: Uint8Array,
  conflict: SpendConflict,
  now: number,
  advertise: ((frameId: string, frame: Uint8Array, ttlSeconds: number) => Promise<void>) | undefined,
) {
  const wire = encodeSpendConflict(conflict)
  const accepted = acceptConflict(noteDomain, 'spend', wire)
  if (!accepted.ok) return
  if ((await recordConflict(db, { ...accepted, known: true }, wire, 'point', now)) !== 'duplicate' && advertise)
    await passOn(db, wire, now, advertise)
}

/**
 * The check a point runs on a verified payment before it stores it: a refusal when the note is not this
 * event's or was spent at another point, and what the payment consumed recorded when it is accepted.
 */
export function pointGate(
  db: NoteDb,
  pairing: PointPairing,
  noteDomain: Uint8Array,
  now: () => number,
  advertise?: (frameId: string, frame: Uint8Array, ttlSeconds: number) => Promise<void>,
): ReceiveGate {
  return {
    async admit(received, bundle) {
      const check = await checkAtPoint(db, pairing, noteDomain, received, bundle, now())
      if (!check.ok) {
        if (check.conflict) await flagAtPoint(db, noteDomain, check.conflict, now(), advertise)
        return REFUSAL[check.reason]
      }
      await recordAtPoint(db, pairing.eventId, check.entries)
      return null
    },
  }
}
