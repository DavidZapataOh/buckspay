import { type Bundle, encodeBundle } from '../../payment/messages'
import { changeOf, planRespend, respendBundle } from '../../payment/respend'
import { planPayment } from '../../payment/preflight'
import {
  NOTE_DOMAIN,
  party,
  payCtx,
  receiverFor,
  requestTo,
  signIssue,
  signSpendWith,
} from '../../payment/testing/world'
import { type Owner, type Received, verifyPayment, walkChain } from '../../protocol'
import type { HeldOutput } from '../../payment/respend'
import type { PointPairing } from './payloads'

const ORGANISER_ACCOUNT = new Uint8Array(32).fill(0xa0)

/** An organiser who sells credit, an attendee who pays it at points, and the pairing the points hold. */
export function eventWorld({ issuerListed = true }: { issuerListed?: boolean } = {}) {
  const organiser = party(1)
  const attendee = party(2)
  const authority: Owner = { type: 'account', address: ORGANISER_ACCOUNT }
  const pairing: PointPairing = {
    eventId: new Uint8Array(16).fill(1),
    authority: ORGANISER_ACCOUNT,
    name: 'Feria',
    endsAt: 1_800_100_000,
    eventSecret: new Uint8Array(32).fill(3),
    issuers: [issuerListed ? organiser.key : party(9).key],
  }
  const organiserContext = payCtx(organiser)
  const attendeeContext = { ...payCtx(attendee), locks: [] }
  const point = receiverFor(organiser, { me: authority })

  /** Sells `amount` of event credit to the attendee: an authority-only issue from the organiser's lock. */
  function issueCredit(amount: bigint): HeldOutput {
    const planned = planPayment(requestTo(attendee, amount), organiserContext, { authorityOnly: ORGANISER_ACCOUNT })
    if (!planned.ok) throw new Error(`credit refused: ${planned.reason}`)
    const issue = signIssue(organiser, planned.plan.issue)
    const [output] = walkChain(NOTE_DOMAIN, issue, []).last
    return { outputId: output.id, output, bundle: { issue, spends: [], tickets: [planned.plan.lock.ticket] } }
  }

  /** The attendee pays `amount` of `held` to the point: what the point receives, and the change it keeps. */
  function payPoint(held: HeldOutput, amount: bigint) {
    const planned = planRespend(requestTo(authority, amount), [held], attendeeContext)
    if (!planned.ok) throw new Error(`payment refused: ${planned.reason}`)
    const { plan } = planned
    const bundle: Bundle = respendBundle(plan, signSpendWith(attendee, held.output, plan.spend))
    const received: Received = verifyPayment(point, bundle.issue, bundle.spends, bundle.tickets)
    const change = changeOf(NOTE_DOMAIN, bundle, null, point.now)
    const [, output] = walkChain(NOTE_DOMAIN, bundle.issue, bundle.spends).last
    const kept: HeldOutput | null = change && output ? { outputId: output.id, output, bundle } : null
    return { received, bundle, wire: encodeBundle(bundle), held: kept }
  }

  return { organiser, attendee, authority, pairing, issueCredit, payPoint }
}
