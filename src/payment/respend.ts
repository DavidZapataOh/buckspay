import { equalBytes } from '@noble/curves/utils.js'
import {
  admits,
  type BondTicket,
  type Caveats,
  CHALLENGE,
  checkSpendStep,
  covers,
  encodeCaveats,
  EXPIRY_STEP,
  Flags,
  forHolder,
  GRACE,
  MAX_NOTE_LIFE,
  NO_LOCK,
  type Output,
  ProtocolError,
  type Signed,
  type Spend,
  walkChain,
} from '../protocol'
import { withRecordableOutputs } from '../keys/salt'
import type { ReceivedNote } from '../features/notes/ledger'
import { type Bundle, encodeBundle, paymentId, type PaymentRequest } from './messages'
import {
  type OfflineLock,
  type PayContext,
  type Plan,
  type PlanRefusal,
  checkRequest,
  reviewOf,
  type Token,
} from './preflight'
import { claimsOf } from './receive'

/** A note this phone holds: its output and the chain that created it, as received. */
export type HeldOutput = {
  outputId: Uint8Array
  output: Output
  bundle: Bundle
}

export type RespendPlan = {
  input: HeldOutput
  spend: Spend
  /** Null when the note is event credit paid to its authority: no lock names it and no bond is needed. */
  lock: OfflineLock | null
  token: Token
  /** The chain's tickets plus this spender's current one, one per lock. */
  tickets: BondTicket[]
  review: Plan['review'] & { kind: 'spend1' | 'spend2'; change: bigint; hopsAfter: number }
}

export type RespendRefusal = PlanRefusal | 'NoPassableNote'
export type Respent = { ok: true; plan: RespendPlan } | { ok: false; reason: RespendRefusal }

const paysItsAuthority = (output: Output, request: PaymentRequest) =>
  (output.caveats.flags & Flags.AuthorityOnly) !== 0 && request.owner.type === 'account'

const sameLock = (a: BondTicket, b: BondTicket) => equalBytes(a.device, b.device) && a.lockSeq === b.lockSeq

const withTicket = (tickets: readonly BondTicket[], own: BondTicket) => [
  ...tickets.filter((ticket) => !sameLock(ticket, own)),
  own,
]

/** Whether a held note can be passed on to this request at all, whatever my locks say. */
function passable(note: HeldOutput, request: PaymentRequest, ctx: PayContext, minExpiry: number, wanted: number) {
  const { output, bundle } = note
  const { caveats } = output
  const rules = forHolder(caveats, output.owner)
  return (
    output.owner.type === 'device' &&
    equalBytes(output.owner.key, ctx.me) &&
    equalBytes(bundle.issue.message.mint, request.mint) &&
    output.amount >= request.amount &&
    (caveats.flags & Flags.Delegated) === 0 &&
    caveats.hopsLeft - 1 >= request.minHops &&
    admits(rules, request.owner) &&
    Math.min(caveats.expiry - EXPIRY_STEP, wanted) >= minExpiry
  )
}

const BY_PREFERENCE = (a: HeldOutput, b: HeldOutput) =>
  a.output.amount === b.output.amount
    ? a.output.caveats.expiry - b.output.caveats.expiry
    : a.output.amount < b.output.amount
      ? -1
      : 1

/**
 * Everything the payer can check before it signs a spend of a held note: what the next receiver's
 * `verifyPayment` will check about the chain and the tickets, except the signature. Pure.
 */
export function planRespend(request: PaymentRequest, held: readonly HeldOutput[], ctx: PayContext): Respent {
  const checked = checkRequest(request, ctx)
  if ('reason' in checked) return { ok: false, reason: checked.reason }
  const { limits } = ctx
  const lastArrival = request.now + limits.requestTtl + limits.transferMargin
  const minExpiry = lastArrival + request.minWindow
  const wanted = request.now + Math.min(limits.noteLifetime, MAX_NOTE_LIFE)
  const candidates = held.filter((note) => passable(note, request, ctx, minExpiry, wanted)).sort(BY_PREFERENCE)
  let refusal: RespendRefusal = 'NoPassableNote'
  for (const [index, note] of candidates.entries()) {
    const planned = planFrom(note, request, ctx, checked.token, lastArrival, wanted)
    if (planned.ok) return planned
    if (index === 0) refusal = planned.reason
  }
  return { ok: false, reason: refusal }
}

function planFrom(
  note: HeldOutput,
  request: PaymentRequest,
  ctx: PayContext,
  token: Token,
  lastArrival: number,
  wanted: number,
): Respent {
  const { output, bundle } = note
  if (bundle.tickets.some((ticket) => ticket.validUntil < lastArrival)) return { ok: false, reason: 'TicketStale' }
  if (paysItsAuthority(output, request)) return planCredit(note, request, ctx, token, wanted)
  const locks = ctx.locks.filter((lock) => equalBytes(lock.mint, request.mint))
  if (locks.length === 0) return { ok: false, reason: 'NoLock' }
  const failure = (lock: OfflineLock) =>
    !request.attesters.includes(lock.ticket.attester)
      ? 0
      : !covers(lock.bond, output.amount)
        ? 1
        : lock.lockUntil <= output.caveats.expiry + GRACE + CHALLENGE
          ? 2
          : lock.ticket.validUntil < lastArrival
            ? 3
            : -1
  const usable = locks
    .filter((lock) => failure(lock) === -1)
    .sort((a, b) => a.lockUntil - b.lockUntil || a.lockSeq - b.lockSeq)
  if (usable.length === 0) {
    const REASONS = ['AttesterNotTrusted', 'BondTooSmall', 'LockTooShort', 'TicketStale'] as const
    return { ok: false, reason: REASONS[Math.max(...locks.map(failure))] }
  }
  const [lock] = usable
  const rules = forHolder(output.caveats, output.owner)
  const expiry = Math.min(output.caveats.expiry - EXPIRY_STEP, wanted)
  const caveats: Caveats = {
    expiry,
    hopsLeft: output.caveats.hopsLeft - 1,
    flags: 0,
    scopeKind: rules.scopeKind,
    scope: rules.scope,
  }
  const signed = signedSpend(note, request, ctx, lock.lockSeq, caveats)
  if (!signed.ok) return signed
  return {
    ok: true,
    plan: {
      ...signed.plan,
      lock,
      token,
      tickets: withTicket(bundle.tickets, lock.ticket),
      review: {
        ...reviewOf(request, ctx, token, lock, request.amount, lock.backing - lock.nextCumEnd, caveats.expiry),
        ...signed.plan.review,
      },
    },
  }
}

/**
 * Event credit paid to its authority: the issuer's lock answers for it, so the spend names no lock and
 * the payer needs no bond. The flag and the scope stay on the change, which only the authority redeems.
 */
function planCredit(note: HeldOutput, request: PaymentRequest, ctx: PayContext, token: Token, wanted: number): Respent {
  const { output, bundle } = note
  if (bundle.tickets.some((ticket) => !request.attesters.includes(ticket.attester))) {
    return { ok: false, reason: 'AttesterNotTrusted' }
  }
  const rules = forHolder(output.caveats, output.owner)
  const caveats: Caveats = {
    expiry: Math.min(output.caveats.expiry - EXPIRY_STEP, wanted),
    hopsLeft: output.caveats.hopsLeft - 1,
    flags: output.caveats.flags & Flags.AuthorityOnly,
    scopeKind: rules.scopeKind,
    scope: rules.scope,
  }
  const signed = signedSpend(note, request, ctx, NO_LOCK, caveats)
  if (!signed.ok) return signed
  return {
    ok: true,
    plan: {
      ...signed.plan,
      lock: null,
      token,
      tickets: bundle.tickets,
      review: { ...reviewOf(request, ctx, token, null, request.amount, null, caveats.expiry), ...signed.plan.review },
    },
  }
}

type Drafted = {
  ok: true
  plan: { input: HeldOutput; spend: Spend; review: Pick<RespendPlan['review'], 'kind' | 'change' | 'hopsAfter'> }
}

/** The spend of `note` to the request's owner with `caveats`, its salt chosen so every output has a record address. */
function signedSpend(
  note: HeldOutput,
  request: PaymentRequest,
  ctx: PayContext,
  lockSeq: number,
  caveats: Caveats,
): Drafted | { ok: false; reason: RespendRefusal } {
  const { output } = note
  const whole = request.amount === output.amount
  const draft: Spend = {
    input: output.id,
    lockSeq,
    salt: ctx.salt(),
    outputs: whole
      ? { type: 'one', owner: request.owner, caveats }
      : { type: 'two', owner0: request.owner, amount0: request.amount, caveats0: caveats, owner1: output.owner },
  }
  try {
    const spend = withRecordableOutputs(
      draft,
      (salt) => ({ ...draft, salt }),
      (candidate) => checkSpendStep(ctx.noteDomain, ctx.program, output, candidate, ctx.now),
      ctx.salt,
    )
    return {
      ok: true,
      plan: {
        input: note,
        spend,
        review: {
          kind: whole ? 'spend1' : 'spend2',
          change: output.amount - request.amount,
          hopsAfter: caveats.hopsLeft,
        },
      },
    }
  } catch (error) {
    if (error instanceof ProtocolError) return { ok: false, reason: 'Malformed' }
    throw error
  }
}

/** The chain after `signed` spends `input`: the input's chain, the new spend and the spender's current ticket. */
export const chainOf = (input: HeldOutput, signed: Signed<Spend>, ticket: BondTicket | null): Bundle => ({
  issue: input.bundle.issue,
  spends: [...input.bundle.spends, signed],
  tickets: ticket ? withTicket(input.bundle.tickets, ticket) : input.bundle.tickets,
})

export const respendBundle = (plan: RespendPlan, signature: Uint8Array): Bundle =>
  chainOf(plan.input, { message: plan.spend, signature }, plan.lock?.ticket ?? null)

/** The change of a signed re-spend as a note this phone holds, or null for a `Spend1`. It is backed by the spender's own lock too, when the spend named one. */
export function changeOf(
  noteDomain: Uint8Array,
  bundle: Bundle,
  ticket: BondTicket | null,
  now: number,
): ReceivedNote | null {
  const { outputs } = bundle.spends[bundle.spends.length - 1].message
  if (outputs.type !== 'two' || outputs.owner1.type !== 'device') return null
  const [, change] = walkChain(noteDomain, bundle.issue, bundle.spends).last
  const issue = bundle.issue.message
  return {
    outputId: change.id,
    messageId: paymentId(noteDomain, bundle),
    owner: outputs.owner1.key,
    mint: issue.mint,
    amount: change.amount,
    expiry: change.caveats.expiry,
    hopsLeft: change.caveats.hopsLeft,
    caveats: encodeCaveats(change.caveats),
    issuer: issue.issuer,
    lockSeq: issue.lockSeq,
    bundle: encodeBundle(bundle),
    liable: ticket
      ? [{ device: ticket.device, lockSeq: ticket.lockSeq, bond: ticket.bond, attester: ticket.attester }]
      : [],
    claims: claimsOf(bundle),
    requestedAmount: null,
    memo: null,
    transport: 'change',
    receivedAt: now,
    keep: true,
  }
}
