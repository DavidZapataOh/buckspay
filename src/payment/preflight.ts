import { bytesToHex } from '@noble/hashes/utils.js'
import { equalBytes } from '@noble/curves/utils.js'
import {
  type BondTicket,
  CHALLENGE,
  checkIssueStep,
  covers,
  Flags,
  type Issue,
  GRACE,
  MAX_DEPTH,
  MAX_NOTE_LIFE,
  ProtocolError,
  ScopeKind,
  scopeHash,
} from '../protocol'
import { withRecordableOutputs } from '../keys/salt'
import { isDeviceKeyOnCurve, type PaymentRequest, requestIdOf, safetyCode, sanitizeMemo } from './messages'

export type OfflineLock = {
  lockSeq: number
  mint: Uint8Array
  bond: bigint
  backing: bigint
  lockUntil: number
  ticket: BondTicket
  /** Where the lock's next issue starts: its cursor in the note store. */
  nextCumEnd: bigint
}

export type Token = { symbol: string; decimals: number }

export type PayLimits = {
  /** How long a note stays valid after the receiver's request, seconds. */
  noteLifetime: number
  noteHops: number
  /** How long a request stays fresh, seconds. */
  requestTtl: number
  /** How far the two clocks may differ, seconds. */
  skewTolerance: number
  /** Time for the payment to travel from the payer's tap to the receiver's check, seconds. */
  transferMargin: number
  maxPayment: bigint
  /** From this amount on, the payer confirms with a biometric or the device credential. */
  biometricFrom: bigint
  /** The same once the day's payments, this one included, reach this total. */
  biometricDaily: bigint
}

export type PayContext = {
  now: number
  me: Uint8Array
  noteDomain: Uint8Array
  /** The settlement program: the output of the issue must have a record address under it. */
  program: Uint8Array
  locks: readonly OfflineLock[]
  tokens: ReadonlyMap<string, Token>
  limits: PayLimits
  salt: () => Uint8Array
  knownReceivers: ReadonlySet<string>
  /** What this phone has paid since midnight, in minor units. */
  paidToday: bigint
  /** Hex of `requestIdOf` for every request this phone already has a live payment for. */
  paidRequests: ReadonlySet<string>
}

export type PlanRefusal =
  | 'Malformed'
  | 'UnknownMint'
  | 'AboveYourLimit'
  | 'SelfPayment'
  | 'ClockOrExpired'
  | 'AlreadyPaid'
  | 'NoLock'
  | 'AttesterNotTrusted'
  | 'BondTooSmall'
  | 'AllowanceTooLow'
  | 'LockTooShort'
  | 'TicketStale'

export type Plan = {
  lock: OfflineLock
  issue: Issue
  token: Token
  review: {
    amount: bigint
    symbol: string
    decimals: number
    receiverCode: string
    receiverIsNew: boolean
    lockSeq: number | null
    allowanceAfter: bigint | null
    expiry: number
    memo: string
    biometric: boolean
  }
}

export type Planned = { ok: true; plan: Plan } | { ok: false; reason: PlanRefusal; lockSeq?: number }

const refuse = (reason: PlanRefusal, lockSeq?: number): Planned => ({ ok: false, reason, lockSeq })

/** The first check a lock fails, in the order the receiver's own checks would, or null. Later is better. */
const CHECKS = ['AttesterNotTrusted', 'BondTooSmall', 'AllowanceTooLow', 'LockTooShort', 'TicketStale'] as const

function lockRefusal(
  lock: OfflineLock,
  request: PaymentRequest,
  expiry: number,
  minExpiry: number,
  cap: number,
  lastArrival: number,
) {
  if (!request.attesters.includes(lock.ticket.attester)) return 0
  if (!covers(lock.bond, request.amount)) return 1
  if (lock.backing - lock.nextCumEnd < request.amount) return 2
  if (expiry < minExpiry || cap < minExpiry) return 3
  if (lock.ticket.validUntil < lastArrival) return 4
  return -1
}

/** What the payer checks about a request before it looks for a way to pay it: the same for an issue and a re-spend. */
export function checkRequest(request: PaymentRequest, ctx: PayContext): { token: Token } | { reason: PlanRefusal } {
  const { limits } = ctx
  const token = ctx.tokens.get(bytesToHex(request.mint))
  if (!token) return { reason: 'UnknownMint' }
  if (request.owner.type === 'device' && equalBytes(request.owner.key, ctx.me)) return { reason: 'SelfPayment' }
  if (!isDeviceKeyOnCurve(request.owner)) return { reason: 'Malformed' }
  if (request.amount > limits.maxPayment) return { reason: 'AboveYourLimit' }
  const age = ctx.now - request.now
  if (age < -limits.skewTolerance || age > limits.requestTtl + limits.skewTolerance) return { reason: 'ClockOrExpired' }
  if (ctx.paidRequests.has(bytesToHex(requestIdOf(request)))) return { reason: 'AlreadyPaid' }
  return { token }
}

/** What the review screen shows of a payment, whichever way it is made. */
export function reviewOf(
  request: PaymentRequest,
  ctx: PayContext,
  token: Token,
  lock: OfflineLock | null,
  amount: bigint,
  allowanceAfter: bigint | null,
  expiry: number,
): Plan['review'] {
  const { limits } = ctx
  return {
    amount,
    symbol: token.symbol,
    decimals: token.decimals,
    receiverCode: safetyCode(request.owner),
    receiverIsNew: !ctx.knownReceivers.has(
      bytesToHex(request.owner.type === 'device' ? request.owner.key : request.owner.address),
    ),
    lockSeq: lock?.lockSeq ?? null,
    allowanceAfter,
    expiry,
    memo: sanitizeMemo(request.memo),
    biometric: amount >= limits.biometricFrom || ctx.paidToday + amount >= limits.biometricDaily,
  }
}

/**
 * Everything the payer can check before it signs: what the receiver's `verifyPayment` will check about
 * the issue and its ticket, except the signature. Pure: the same inputs give the same plan. With
 * `authorityOnly` (an account address) the issue is event credit: redeemable only by paying that account.
 */
export function planPayment(
  request: PaymentRequest,
  ctx: PayContext,
  opts: { authorityOnly?: Uint8Array } = {},
): Planned {
  const { limits } = ctx
  const checked = checkRequest(request, ctx)
  if ('reason' in checked) return refuse(checked.reason)
  if (opts.authorityOnly && request.owner.type !== 'device') return refuse('Malformed')
  const { token } = checked
  const hopsLeft = Math.min(MAX_DEPTH, Math.max(request.minHops, limits.noteHops))
  const lastArrival = request.now + limits.requestTtl + limits.transferMargin
  const minExpiry = lastArrival + request.minWindow
  const wanted = request.now + Math.min(limits.noteLifetime, MAX_NOTE_LIFE)
  const candidates = ctx.locks.filter((lock) => equalBytes(lock.mint, request.mint))
  if (candidates.length === 0) return refuse('NoLock')
  const scored = candidates.map((lock) => {
    const cap = lock.lockUntil - GRACE - CHALLENGE - 1
    const expiry = Math.min(wanted, cap)
    return { lock, expiry, cap, failed: lockRefusal(lock, request, expiry, minExpiry, cap, lastArrival) }
  })
  const usable = scored
    .filter((s) => s.failed === -1)
    .sort((a, b) => a.lock.lockUntil - b.lock.lockUntil || a.lock.lockSeq - b.lock.lockSeq)
  if (usable.length === 0) {
    const best = scored.reduce((a, b) => (b.failed > a.failed ? b : a))
    return refuse(CHECKS[best.failed], best.lock.lockSeq)
  }
  const { lock, expiry } = usable[0]
  const draft: Issue = {
    issuer: ctx.me,
    mint: request.mint,
    lockSeq: lock.lockSeq,
    cumEnd: lock.nextCumEnd + request.amount,
    salt: ctx.salt(),
    owner: request.owner,
    amount: request.amount,
    caveats: opts.authorityOnly
      ? {
          expiry,
          hopsLeft,
          flags: Flags.AuthorityOnly,
          scopeKind: ScopeKind.Authority,
          scope: scopeHash({ type: 'account', address: opts.authorityOnly }),
        }
      : { expiry, hopsLeft, flags: 0, scopeKind: ScopeKind.Any, scope: new Uint8Array(20) },
  }
  let issue: Issue
  try {
    issue = withRecordableOutputs(
      draft,
      (salt) => ({ ...draft, salt }),
      (candidate) => checkIssueStep(ctx.noteDomain, ctx.program, candidate),
      ctx.salt,
    )
  } catch (error) {
    if (error instanceof ProtocolError) return refuse('Malformed', lock.lockSeq)
    throw error
  }
  return {
    ok: true,
    plan: {
      lock,
      issue,
      token,
      review: reviewOf(request, ctx, token, lock, issue.amount, lock.backing - issue.cumEnd, expiry),
    },
  }
}
