import { type Attester, type Receiver } from '../../protocol'
import { acceptancePolicy, AttesterLedger } from '../attesters'
import { relianceByAttester } from '../notes/ledger'
import type { NoteDb } from '../notes/db'
import { MIN_WINDOW } from '../pay/limits'

export type PaymentDomains = { noteDomain: Uint8Array; ticketDomain: Uint8Array; program: Uint8Array }

/**
 * The receiver `verifyPayment` runs for this wallet at `now`: the attesters it believes, each with what
 * its unsettled notes already rely on it for, and the window and note life it requires.
 */
export async function receiverOf(
  db: NoteDb,
  domains: PaymentDomains,
  key: Uint8Array,
  attesters: readonly Attester[],
  now: number,
): Promise<Receiver> {
  const ledger = AttesterLedger.fromJSON(await relianceByAttester(db))
  return acceptancePolicy({
    ...domains,
    me: { type: 'device', key },
    now,
    attesters: ledger.apply([...attesters]),
    minWindow: MIN_WINDOW,
  })
}
