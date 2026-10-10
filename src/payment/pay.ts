import { equalBytes } from '@noble/curves/utils.js'
import { concatBytes } from '@noble/hashes/utils.js'
import {
  content,
  decodeBondTicket,
  decodeIssue,
  decodeSpend,
  encodeBondTicket,
  encodeIssueBody,
  encodeSpendBody,
  envelope,
  type Issue,
  interval,
  issueSlot,
  messageId,
  type Output,
  type Signed,
  type Spend,
} from '../protocol'
import type { NoteDb } from '../features/notes/db'
import { mark, pause, report } from '../features/pay/timing'
import {
  heldOutput,
  markRespendSigned,
  markSigned,
  OutputTaken,
  preparePayment,
  prepareRespend,
  setOutgoingState,
  unfinishedPayments,
} from '../features/notes/outgoing'
import { type Transport, MessageKind, TransportError } from '../transport/types'
import { decodeReceipt, encodeBundle, type PaymentRequest, requestIdOf } from './messages'
import type { Plan } from './preflight'
import { Reason } from './reasons'
import { chainOf, changeOf, type RespendPlan } from './respend'

export type PayDeps = {
  db: NoteDb
  /** `signIssue` of `src/keys`: native, guarded, low-S, verified. */
  sign: (issue: Issue) => Promise<Uint8Array>
  transport: Transport
  /** The biometric or device-credential prompt; resolves false when the person declines. */
  authenticate: (amount: bigint) => Promise<boolean>
  noteDomain: Uint8Array
  now: () => number
  /** `signSpend` of `src/keys`: needed to pay from a note this phone holds. */
  signSpend?: (input: Output, spend: Spend) => Promise<Signed<Spend>>
}

/** What signing a payment needs: everything of `PayDeps`, and of the transport only the way to send. */
export type SignDeps = Omit<PayDeps, 'transport'> & { transport: Pick<Transport, 'send'> }

export class PayError extends Error {
  constructor(
    readonly code: 'Declined' | 'IntervalTaken' | 'SignFailed' | 'SendFailed' | 'Mismatch',
    /** What failed underneath, for the screen to explain (for a native error, its `code`). */
    readonly cause?: unknown,
  ) {
    super(code)
    this.name = 'PayError'
  }
}

export type SentPayment = { messageId: Uint8Array; bundle: Uint8Array }

/** The id a receipt will name: the issue's message id, known before anything is signed. */
export function issueMessageId(noteDomain: Uint8Array, issue: Issue): Uint8Array {
  const [start, end] = interval(issue)
  return messageId(envelope(noteDomain, issueSlot(issue.lockSeq, start, end), content(encodeIssueBody(issue))))
}

/** The issue a stored body is: what was or will be signed, read back. */
export const storedIssue = (body: Uint8Array) => decodeIssue(concatBytes(body, new Uint8Array(64))).message

/**
 * The payer's side after the person pressed Pay: confirm (above the threshold), write the issue and
 * advance the lock's cursor, sign, write the signature and the exact bytes, hand them to the transport.
 * Every step is recoverable: see `resumePayments`.
 */
export async function confirmAndSend(
  plan: Plan,
  request: PaymentRequest,
  transport: string,
  deps: SignDeps,
): Promise<SentPayment> {
  const { issue } = plan
  if (plan.review.biometric && !(await deps.authenticate(issue.amount))) throw new PayError('Declined')
  mark('tap')
  const id = issueMessageId(deps.noteDomain, issue)
  const [cumStart, cumEnd] = interval(issue)
  try {
    await preparePayment(deps.db, {
      messageId: id,
      device: issue.issuer,
      requestId: requestIdOf(request),
      receiver: request.owner.type === 'device' ? request.owner.key : request.owner.address,
      mint: issue.mint,
      amount: issue.amount,
      lockSeq: issue.lockSeq,
      cumStart,
      cumEnd,
      expiry: issue.caveats.expiry,
      issueBody: encodeIssueBody(issue),
      ticket: encodeBondTicket(plan.lock.ticket),
      memo: request.memo || null,
      transport,
      now: deps.now(),
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'IntervalTaken') throw new PayError('IntervalTaken')
    throw error
  }
  mark('prepared')
  await pause()
  const sent = await signAndSend(id, issue, plan.lock.ticket, deps)
  mark('presented')
  report()
  return sent
}

async function signAndSend(
  id: Uint8Array,
  issue: Issue,
  ticket: Plan['lock']['ticket'],
  deps: SignDeps,
): Promise<SentPayment> {
  if (!equalBytes(issueMessageId(deps.noteDomain, issue), id)) throw new PayError('Mismatch')
  let signature: Uint8Array
  try {
    signature = await deps.sign(issue)
  } catch (error) {
    throw error instanceof PayError ? error : new PayError('SignFailed', error)
  }
  const bundle = encodeBundle({ issue: { message: issue, signature }, spends: [], tickets: [ticket] })
  await markSigned(deps.db, id, signature, bundle, deps.now())
  mark('signed')
  await pause()
  await send(bundle, deps)
  return { messageId: id, bundle }
}

/**
 * The payer's side of passing a received note on: the same steps as `confirmAndSend`, but the spend body
 * is written, with the input taken out of `held`, before it is signed. Recoverable by `resumePayments`.
 */
export async function confirmAndSendRespend(
  plan: RespendPlan,
  request: PaymentRequest,
  transport: string,
  deps: PayDeps & { signSpend: NonNullable<PayDeps['signSpend']> },
): Promise<SentPayment> {
  if (plan.review.biometric && !(await deps.authenticate(plan.review.amount))) throw new PayError('Declined')
  mark('tap')
  const body = encodeSpendBody(plan.spend)
  const input = plan.input.output.id
  const id = messageId(envelope(deps.noteDomain, input, content(body)))
  try {
    await prepareRespend(deps.db, {
      input,
      messageId: id,
      body,
      requestId: requestIdOf(request),
      now: deps.now(),
      receiver: request.owner.type === 'device' ? request.owner.key : request.owner.address,
      amount: plan.review.amount,
      lockSeq: plan.spend.lockSeq,
      expiry: plan.review.expiry,
      ticket: plan.lock ? encodeBondTicket(plan.lock.ticket) : undefined,
      memo: request.memo || null,
      transport,
    })
  } catch (error) {
    if (error instanceof OutputTaken) throw new PayError('IntervalTaken')
    throw error
  }
  mark('prepared')
  const sent = await signAndSendRespend(id, input, body, plan.lock ? encodeBondTicket(plan.lock.ticket) : null, deps)
  mark('presented')
  report()
  return sent
}

async function signAndSendRespend(
  id: Uint8Array,
  inputId: Uint8Array,
  body: Uint8Array,
  ticketBytes: Uint8Array | null,
  deps: SignDeps,
): Promise<SentPayment> {
  const ticket = ticketBytes?.length ? decodeBondTicket(ticketBytes) : null
  const input = await heldOutput(deps.db, inputId)
  if (!input || !deps.signSpend) throw new PayError('Mismatch')
  if (!equalBytes(messageId(envelope(deps.noteDomain, inputId, content(body))), id)) throw new PayError('Mismatch')
  const spend = decodeSpend(concatBytes(inputId, body, new Uint8Array(64))).message
  let signed: Signed<Spend>
  try {
    signed = await deps.signSpend(input.output, spend)
  } catch (error) {
    throw error instanceof PayError ? error : new PayError('SignFailed', error)
  }
  if (!equalBytes(encodeSpendBody(signed.message), body)) throw new PayError('Mismatch')
  const bundle = chainOf(input, signed, ticket)
  const wire = encodeBundle(bundle)
  await markRespendSigned(deps.db, {
    messageId: id,
    signature: signed.signature,
    bundle: wire,
    change: changeOf(deps.noteDomain, bundle, ticket, deps.now()),
    now: deps.now(),
  })
  mark('signed')
  await send(wire, deps)
  return { messageId: id, bundle: wire }
}

async function send(bundle: Uint8Array, deps: SignDeps) {
  try {
    await deps.transport.send({ kind: MessageKind.Payment, payload: bundle })
  } catch (error) {
    throw new PayError('SendFailed', error)
  }
}

/**
 * After a restart, for every unfinished payment or only the one asked for: a payment whose signature was never stored is signed again from the stored body
 * (the guard allows the same content again), one that was signed is shown again byte for byte.
 * Nothing here ever builds a new issue.
 */
export async function resumePayments(deps: SignDeps, only?: Uint8Array): Promise<SentPayment[]> {
  const resumed: SentPayment[] = []
  for (const row of await unfinishedPayments(deps.db)) {
    if (only && !equalBytes(row.messageId, only)) continue
    if (row.bundle) {
      await send(row.bundle, deps)
      resumed.push({ messageId: row.messageId, bundle: row.bundle })
      continue
    }
    resumed.push(
      row.input
        ? await signAndSendRespend(row.messageId, row.input, row.issueBody, row.ticket, deps)
        : await signAndSend(row.messageId, storedIssue(row.issueBody), decodeBondTicket(row.ticket), deps),
    )
  }
  return resumed
}

export type ReceiptResult =
  { status: 'confirmed' } | { status: 'rejected'; reason: Reason } | { status: 'other-payment' }

/** Waits for the receiver's reply (unsigned, so a convenience and never evidence) and records it. */
export async function awaitReceipt(
  payment: SentPayment,
  deps: PayDeps,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ReceiptResult> {
  for (;;) {
    const message = await deps.transport.receive({ ...options, accept: [MessageKind.Receipt] })
    let receipt
    try {
      receipt = decodeReceipt(message.payload)
    } catch {
      continue
    }
    if (
      receipt.messageId.length !== payment.messageId.length ||
      receipt.messageId.some((b, i) => b !== payment.messageId[i])
    ) {
      return { status: 'other-payment' }
    }
    if (receipt.accepted) {
      await setOutgoingState(deps.db, payment.messageId, 'confirmed', deps.now())
      return { status: 'confirmed' }
    }
    await setOutgoingState(deps.db, payment.messageId, 'rejected', deps.now(), receipt.reason)
    return { status: 'rejected', reason: receipt.reason }
  }
}

export { TransportError }
