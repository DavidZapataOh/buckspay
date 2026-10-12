import { equalBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { content, decodeIssue, encodeIssueBody, interval, issueSlot, outputId, recordAddress } from '../../protocol'
import { awaitRequest } from '../../payment/scan'
import { decodeBundle, paymentId, type PaymentRequest } from '../../payment/messages'
import { awaitReceipt, confirmAndSend, PayError, type PayDeps, resumePayments } from '../../payment/pay'
import { type PayContext, planPayment } from '../../payment/preflight'
import { type ReceiveContext } from '../../payment/receive'
import { receivePayment, showRequest } from '../../payment/receive-flow'
import { type Transport, MessageKind, TransportError } from '../../transport/types'
import { type DebtsContext, proposeRepay, answerTabOffer } from '../debts/flow'
import type { CoSignedIou } from '../../protocol'
import type { NoteDb } from '../notes/db'
import type { SettlementRequest } from '../lock/gateway'
import { settlementRequest } from '../settlement/chain'
import { type Debt, simplify, type Transfer } from './cycles'

export const RemainderStatus = { Due: 0, Repaid: 1, Released: 2, Skipped: 3 } as const

export type RemainderTab = {
  tab: Uint8Array
  peer: number
  role: 'debtor' | 'creditor'
  remaining: bigint
  /** The peer's device key. */
  peerKey: Uint8Array
  state: CoSignedIou
}

export class RemainderRefusal extends Error {
  constructor(
    readonly code:
      'WrongPayee' | 'WrongAmount' | 'WrongMint' | 'WrongReference' | 'ReferenceReused' | 'NoFunds' | 'Declined',
  ) {
    super(code)
    this.name = 'RemainderRefusal'
  }
}

export type RemainderResult = {
  status: 'repaid' | 'released' | 'declined' | 'failed'
  messageId?: Uint8Array
  reason?: RemainderRefusal['code'] | 'Timeout' | 'Unreadable'
}

export type RemainderDeps = {
  db: NoteDb
  now: () => number
  mint: Uint8Array
  session: Uint8Array
  debts: DebtsContext
  link: (peer: number) => Transport
  payContext: () => Promise<PayContext>
  payDeps: () => Omit<PayDeps, 'transport'>
  receiveContext: () => Promise<ReceiveContext>
  requestFor: (tab: RemainderTab) => PaymentRequest
  /** The creditor shows its request again this often until an offer arrives, for a debtor that comes later. */
  reshowMs?: number
  timeouts: { request: number; repay: number; payment: number; receipt: number }
}

/** A row for every tab with something left after the netting (or after "nothing to net"). */
export async function collectRemainder(db: NoteDb, session: Uint8Array, tabs: readonly RemainderTab[]): Promise<void> {
  for (const tab of tabs) {
    if (tab.remaining <= 0n) continue
    await db.run(
      'INSERT OR IGNORE INTO netting_remainder (session, tab, message_id, chain, status) VALUES (?, ?, NULL, NULL, ?)',
      [session, tab.tab, RemainderStatus.Due],
    )
  }
}

export async function skipRemainder(db: NoteDb, session: Uint8Array, tab: Uint8Array): Promise<void> {
  await db.run('UPDATE netting_remainder SET status = ? WHERE session = ? AND tab = ?', [
    RemainderStatus.Skipped,
    session,
    tab,
  ])
}

const setRemainder = (deps: RemainderDeps, tab: Uint8Array, status: number, messageId?: Uint8Array) =>
  deps.db.run(
    'UPDATE netting_remainder SET status = ?, message_id = coalesce(?, message_id) WHERE session = ? AND tab = ?',
    [status, messageId ?? null, deps.session, tab],
  )

/** The request on the wire must pay the tab's creditor exactly what is left, in the session's mint. */
export function checkRemainderRequest(request: PaymentRequest, tab: RemainderTab, mint: Uint8Array): void {
  if (request.owner.type !== 'device' || !equalBytes(request.owner.key, tab.peerKey))
    throw new RemainderRefusal('WrongPayee')
  if (request.amount !== tab.remaining) throw new RemainderRefusal('WrongAmount')
  if (!equalBytes(request.mint, mint)) throw new RemainderRefusal('WrongMint')
}

const timedOut = (error: unknown) => error instanceof TransportError && error.code === 'Timeout'

/**
 * Debtor. Signs the payment and holds it, offers the conditional Repay naming it, and releases the note only after the
 * creditor co-signed the Repay and this phone stored it.
 */
export async function payRemainder(
  deps: RemainderDeps,
  tab: RemainderTab,
  signal: AbortSignal,
): Promise<RemainderResult> {
  const link = deps.link(tab.peer)
  let request: PaymentRequest
  try {
    request = await awaitRequest(link, { signal, timeoutMs: deps.timeouts.request, onWrongCode: () => undefined })
    checkRemainderRequest(request, tab, deps.mint)
  } catch (error) {
    if (error instanceof RemainderRefusal) return { status: 'failed', reason: error.code }
    if (timedOut(error)) return { status: 'failed', reason: 'Timeout' }
    throw error
  }
  const planned = planPayment(request, await deps.payContext())
  if (!planned.ok) return { status: 'failed', reason: 'NoFunds' }
  // Signing and storing the payment is all that happens here: nothing leaves the phone until the Repay is co-signed.
  const holder = { send: async () => undefined }
  let sent
  try {
    sent = await confirmAndSend(planned.plan, request, 'nearby', { ...deps.payDeps(), transport: holder })
  } catch (error) {
    if (error instanceof PayError && error.code === 'Declined') return { status: 'declined' }
    throw error
  }
  const bundle = decodeBundle(sent.bundle)
  const stored = utf8ToBytes(JSON.stringify(settlementRequest({ issue: bundle.issue, spends: bundle.spends })))
  let released = false
  const deadline = new AbortController()
  const stop = () => deadline.abort()
  signal.addEventListener('abort', stop)
  const timer = setTimeout(stop, deps.timeouts.repay)
  try {
    await proposeRepay(
      deps.debts,
      link,
      tab.peerKey,
      {
        messageId: sent.messageId,
        amount: tab.remaining,
        request: stored,
        release: async () => {
          await setRemainder(deps, tab.tab, RemainderStatus.Repaid, sent.messageId)
          try {
            await link.send({ kind: MessageKind.Payment, payload: sent.bundle })
            released = true
          } catch (error) {
            if (!(error instanceof TransportError)) throw error
          }
        },
      },
      deadline.signal,
    )
  } catch (error) {
    if (timedOut(error) || deadline.signal.aborted) return { status: 'failed', reason: 'Timeout' }
    return { status: 'declined' }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
  if (!released) return { status: 'repaid', messageId: sent.messageId }
  await setRemainder(deps, tab.tab, RemainderStatus.Released)
  try {
    await awaitReceipt(sent, { ...deps.payDeps(), transport: link }, { signal, timeoutMs: deps.timeouts.receipt })
  } catch (error) {
    if (!timedOut(error)) throw error
  }
  return { status: 'released', messageId: sent.messageId }
}

const ZERO = new Uint8Array(32)

/** Creditor. Shows the request, answers the Repay offer (its row is written before the answer), then takes the note. */
export async function receiveRemainder(
  deps: RemainderDeps,
  tab: RemainderTab,
  signal: AbortSignal,
): Promise<RemainderResult> {
  const link = deps.link(tab.peer)
  const deadline = new AbortController()
  const stop = () => deadline.abort()
  signal.addEventListener('abort', stop)
  const timer = setTimeout(stop, deps.timeouts.repay + deps.timeouts.request)
  try {
    return await receiveWith(deps, tab, link, deadline.signal)
  } catch (error) {
    if (error instanceof TransportError) return { status: 'failed', reason: 'Timeout' }
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
  }
}

async function receiveWith(
  deps: RemainderDeps,
  tab: RemainderTab,
  link: Transport,
  signal: AbortSignal,
): Promise<RemainderResult> {
  const request = deps.requestFor(tab)
  await showRequest(request, link)
  const again = deps.reshowMs
    ? setInterval(() => void showRequest(request, link).catch(() => undefined), deps.reshowMs)
    : undefined
  const review = async ({
    state,
  }: {
    state: { cause: number; amount: bigint; reference: Uint8Array; debtor: Uint8Array }
  }) => {
    clearInterval(again)
    if (state.cause !== 2 || state.amount !== tab.remaining || !equalBytes(state.debtor, tab.peerKey)) return false
    if (equalBytes(state.reference, ZERO)) return false
    const [used] = await deps.db.all('SELECT 1 FROM repay_notes WHERE tab = ? AND reference = ?', [
      tab.tab,
      state.reference,
    ])
    return !used
  }
  let cosigned
  try {
    cosigned = await answerTabOffer(deps.debts, link, review, signal)
  } catch (error) {
    if (timedOut(error)) return { status: 'failed', reason: 'Timeout' }
    throw error
  } finally {
    clearInterval(again)
  }
  if (!cosigned) return { status: 'declined' }
  await setRemainder(deps, tab.tab, RemainderStatus.Repaid, cosigned.iou.reference)
  try {
    const outcome = await receivePayment(deps.receiveContext, link, { signal, timeoutMs: deps.timeouts.payment })
    if (!outcome.accepted) return { status: 'failed', messageId: cosigned.iou.reference }
  } catch (error) {
    if (timedOut(error)) return { status: 'repaid', messageId: cosigned.iou.reference }
    throw error
  }
  await setRemainder(deps, tab.tab, RemainderStatus.Released)
  return { status: 'released', messageId: cosigned.iou.reference }
}

/** Debtor, after a dropped link: sends the held bundle again until the payment window ends. */
export async function resumeRelease(
  deps: RemainderDeps,
  messageId: Uint8Array,
  transport: Transport,
): Promise<RemainderResult> {
  await resumePayments({ ...deps.payDeps(), transport }, messageId)
  await deps.db.run('UPDATE netting_remainder SET status = ? WHERE session = ? AND message_id = ?', [
    RemainderStatus.Released,
    deps.session,
    messageId,
  ])
  return { status: 'released', messageId }
}

/** The stored requests of this session's settling repayments, for "settle together"; none unless the switch is on. */
export async function collectChains(
  deps: { db: NoteDb; settleTogether: boolean },
  session: Uint8Array,
): Promise<SettlementRequest[]> {
  if (!deps.settleTogether) return []
  const rows = await deps.db.all<{ request: Uint8Array }>(
    `SELECT r.request FROM repay_notes r JOIN netting_remainder m ON m.tab = r.tab AND m.message_id = r.reference
     WHERE m.session = ? AND r.status = 0 AND r.request IS NOT NULL`,
    [session],
  )
  return rows.map((row) => JSON.parse(new TextDecoder().decode(row.request)) as SettlementRequest)
}

/** Fewer payments for the remainder, any path length; a netting bound by the cap leaves a cycle and offers nothing. */
export function proposeSimplification(n: number, rest: readonly Debt[]): Transfer[] {
  try {
    return simplify(n, rest)
  } catch (error) {
    if (error instanceof RangeError) return []
    throw error
  }
}

export type NoteOutcome = 'settling' | 'settled' | 'void' | 'unknown' | 'undecided'
export type NoteStateInput = {
  request: SettlementRequest
  reference: Uint8Array
  payee: Uint8Array
  reduction: bigint
  mint: Uint8Array
}
export type ChainAccount = { slot: bigint; owner: Uint8Array; data: Uint8Array } | null
export type SignatureInfo = {
  signature: string
  blockTime: number
  success: boolean
  /** The content of the Spent record this transaction created, if it created one. */
  creates?: { address: Uint8Array; content: Uint8Array }
}
export type NoteStateDeps = {
  chain: { account: (address: Uint8Array) => Promise<ChainAccount>; now: () => Promise<number> }
  programId: Uint8Array
  noteDomain: Uint8Array
  /** The last second the note can still be settled or reclaimed. */
  settleEnd: (expiry: number) => number
  closableAt: (expiry: number) => number
  history: (address: Uint8Array, before?: string) => Promise<SignatureInfo[]>
}

const SPENT_DISCRIMINATOR = sha256(utf8ToBytes('account:Spent')).slice(0, 8)
const SPENT_LEN = 8 + 32 + 32 + 4 + 4 + 1
const PAID = 1

type Spent = { content: Uint8Array; paid: boolean }

function parseSpent(account: ChainAccount, programId: Uint8Array): Spent | null {
  if (!account || !equalBytes(account.owner, programId) || account.data.length !== SPENT_LEN) return null
  if (!equalBytes(account.data.subarray(0, 8), SPENT_DISCRIMINATOR)) return null
  return { content: account.data.slice(8, 40), paid: (account.data[SPENT_LEN - 1] & PAID) === PAID }
}

/**
 * Reads whether the remainder note behind a Repay settled to its payee, from finalized chain reads only. The request
 * is bound to the Repay first (payment id, output 0, amount, mint); anything else is `unknown` and nothing is read.
 * A `void` is never final on one read: the sweep needs a second one.
 */
export async function noteState(input: NoteStateInput, deps: NoteStateDeps): Promise<NoteOutcome> {
  let bundle
  try {
    bundle = { issue: decodeIssue(hexToBytes(input.request.issue)), spends: input.request.spends }
  } catch {
    return 'unknown'
  }
  const { message: issue } = bundle.issue
  const bound =
    bundle.spends.length === 0 &&
    equalBytes(paymentId(deps.noteDomain, { issue: bundle.issue, spends: [] }), input.reference) &&
    issue.owner.type === 'device' &&
    equalBytes(issue.owner.key, input.payee) &&
    issue.amount >= input.reduction &&
    equalBytes(issue.mint, input.mint)
  if (!bound) return 'unknown'

  const [start, end] = interval(issue)
  const slot = issueSlot(issue.lockSeq, start, end)
  const message = content(encodeIssueBody(issue))
  const output = outputId(input.reference, 0)
  const input_ = recordAddress(deps.programId, slot)
  const out_ = recordAddress(deps.programId, output)
  if (!input_ || !out_) return 'unknown'
  const spent = parseSpent(await deps.chain.account(input_), deps.programId)
  const time = await deps.chain.now()
  const settleEnd = deps.settleEnd(issue.caveats.expiry)
  const closable = deps.closableAt(issue.caveats.expiry)
  const fromHistory = async (address: Uint8Array, match: (info: SignatureInfo) => boolean): Promise<NoteOutcome> => {
    let before: string | undefined
    for (;;) {
      const page = await deps.history(address, before)
      if (page.length === 0) return 'undecided'
      if (page.some((info) => info.success && match(info))) return 'settled'
      if (page.some((info) => info.blockTime < settleEnd)) return 'void'
      before = page[page.length - 1].signature
    }
  }
  if (spent) {
    if (!equalBytes(spent.content, message)) return 'void'
    if (spent.paid) return 'settled'
    const next = parseSpent(await deps.chain.account(out_), deps.programId)
    if (next) return 'settled'
    if (time < settleEnd) return 'settling'
    if (time < closable) return 'void'
    return fromHistory(out_, (info) => !!info.creates)
  }
  if (time < settleEnd) return 'settling'
  if (time < closable) return 'void'
  return fromHistory(input_, (info) => !!info.creates && equalBytes(info.creates.content, message))
}
