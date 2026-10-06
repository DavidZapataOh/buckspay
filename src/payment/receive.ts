import { equalBytes } from '@noble/curves/utils.js'
import {
  content,
  encodeCaveats,
  encodeIssue,
  encodeOwner,
  encodeIssueBody,
  encodeSpend,
  encodeSpendBody,
  interval,
  type Receiver,
  verifyPayment,
} from '../protocol'
import type { NoteDb } from '../features/notes/db'
import { type Claim, commitReceived, type ReceivedNote } from '../features/notes/ledger'
import type { Limits } from '../features/notes/policy'
import { mark } from '../features/pay/timing'
import { type Bundle, decodeBundle, paymentId } from './messages'
import { Reason, reasonOf } from './reasons'

export type ReceiveContext = {
  receiver: Receiver
  db: NoteDb
  limits: Limits
  transport: string
  /** The request this phone is showing, if any: only for display, never a condition. */
  request: { amount: bigint; memo: string } | null
}

export type Outcome =
  | { accepted: true; duplicate: boolean; messageId: Uint8Array; note: ReceivedNote }
  | { accepted: false; reason: Reason; messageId: Uint8Array | null }

const REFUSAL = { DoubleSpend: Reason.DoubleSpend, OverLimit: Reason.OverLimit, AboveMax: Reason.AboveMax } as const

function claimsOf({ issue, spends }: Bundle): Claim[] {
  const [start, end] = interval(issue.message)
  return [
    {
      kind: 'issue',
      issuer: issue.message.issuer,
      lockSeq: issue.message.lockSeq,
      start,
      end,
      content: content(encodeIssueBody(issue.message)),
      wire: encodeIssue(issue),
    },
    ...spends.map((spend): Claim => ({
      kind: 'spend',
      input: spend.message.input,
      content: content(encodeSpendBody(spend.message)),
      wire: encodeSpend(spend),
    })),
  ]
}

/**
 * Decodes a payment, runs the protocol's `verifyPayment`, then stores it under the wallet's own rules
 * in one transaction. It never throws for a bad payment: the outcome says why it was refused.
 */
export async function acceptPayment(payload: Uint8Array, ctx: ReceiveContext): Promise<Outcome> {
  let bundle: Bundle
  try {
    bundle = decodeBundle(payload)
  } catch {
    return { accepted: false, reason: Reason.Unreadable, messageId: null }
  }
  const messageId = paymentId(ctx.receiver.noteDomain, bundle)
  let received
  try {
    received = verifyPayment(ctx.receiver, bundle.issue, bundle.spends, bundle.tickets)
  } catch (error) {
    return { accepted: false, reason: reasonOf(error), messageId }
  }
  mark('verified')
  const note: ReceivedNote = {
    outputId: received.output.id,
    messageId,
    owner: encodeOwner(ctx.receiver.me),
    mint: received.mint,
    amount: received.output.amount,
    expiry: received.output.caveats.expiry,
    hopsLeft: received.output.caveats.hopsLeft,
    caveats: encodeCaveats(received.output.caveats),
    issuer: received.issuer,
    lockSeq: received.lockSeq,
    bundle: payload,
    liable: received.liable,
    claims: claimsOf(bundle),
    requestedAmount: ctx.request?.amount ?? null,
    memo: ctx.request?.memo ?? null,
    transport: ctx.transport,
    receivedAt: ctx.receiver.now,
  }
  try {
    const commit = await commitReceived(ctx.db, note, ctx.limits)
    mark('stored')
    if (commit.status === 'refused') return { accepted: false, reason: REFUSAL[commit.reason], messageId }
    return { accepted: true, duplicate: commit.status === 'duplicate', messageId, note }
  } catch {
    return { accepted: false, reason: Reason.NotSaved, messageId }
  }
}

export const isFor = (outcome: Outcome, id: Uint8Array) =>
  outcome.messageId !== null && equalBytes(outcome.messageId, id)
