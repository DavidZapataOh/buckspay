import { equalBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  checkFollows,
  checkIou,
  type CoSignedIou,
  content,
  encodeIou,
  type Iou,
  IouCause,
  type IouCauseValue,
  iouEnvelope,
  ProtocolError,
  U64_MAX,
  verifySignature,
} from '../../protocol'

export type TabRefusalReason =
  | 'malformed'
  | 'stale'
  | 'not-following'
  | 'wrong-peer'
  | 'wrong-mint'
  | 'bad-signature'
  | 'locked'
  | 'other-tab'
  | 'memo'
  | 'amount'
  | 'pending'
  | 'seq-jump'

export class TabRefusal extends Error {
  constructor(readonly reason: TabRefusalReason) {
    super(reason)
    this.name = 'TabRefusal'
  }
}

/** A change to build: `open` only when there is no previous state. */
export type TabChange = {
  debtor: Uint8Array
  creditor: Uint8Array
  amount: bigint
  due: number
  cause: IouCauseValue
  reference: Uint8Array
  memo: Uint8Array
  open?: { tab: Uint8Array; mint: Uint8Array }
}

export type TabIntent = {
  kind: 'lent' | 'borrowed' | 'repaid' | 'clear'
  amount: bigint
  due: number
  memo: string | null
}

/** What a change is built against: this phone's balance (+ = the peer owes me) and whether a pending item blocks "clear". */
export type TabNow = { balance: bigint; pending: boolean }

export type TabContext = {
  me: Uint8Array
  peer: Uint8Array
  mint: Uint8Array
  previous: CoSignedIou | null
  /** The content of every co-signed state held. */
  held: readonly Uint8Array[]
  nextSeq: number
  now: TabNow
  iouDomain: Uint8Array
}

/** How far above this phone's next `seq` an offered one may be. */
export const SEQ_WINDOW = 2 ** 16
export const MAX_MEMO_BYTES = 120

const ZERO = new Uint8Array(32)
const isZero = (bytes: Uint8Array) => bytes.every((byte) => byte === 0)

export const memoHash = (memo: string | null): Uint8Array =>
  memo === null || memo === '' ? new Uint8Array(32) : sha256(utf8ToBytes(memo))

const contentOf = (state: CoSignedIou) => content(encodeIou(state.iou))

/** Builds the change a person asked for, as a delta against `now`: it never reads an earlier amount. */
export function intentChange(me: Uint8Array, peer: Uint8Array, intent: TabIntent, now: TabNow): TabChange {
  if (utf8ToBytes(intent.memo ?? '').length > MAX_MEMO_BYTES) throw new TabRefusal('memo')
  const change = (debtor: Uint8Array, creditor: Uint8Array, amount: bigint, cause: IouCauseValue): TabChange => {
    if (amount <= 0n || amount > U64_MAX) throw new TabRefusal('amount')
    return { debtor, creditor, amount, due: intent.due, cause, reference: ZERO, memo: memoHash(intent.memo) }
  }
  const owed = now.balance > 0n
  const size = owed ? now.balance : -now.balance
  switch (intent.kind) {
    case 'lent':
      return change(peer, me, intent.amount, IouCause.Open)
    case 'borrowed':
      return change(me, peer, intent.amount, IouCause.Open)
    case 'repaid':
      if (intent.amount > size) throw new TabRefusal('amount')
      return change(owed ? peer : me, owed ? me : peer, intent.amount, IouCause.Outside)
    case 'clear':
      if (now.pending) throw new TabRefusal('pending')
      return change(owed ? peer : me, owed ? me : peer, size, IouCause.Outside)
  }
}

/** The state that adds `change` after `prev` at `seq`; an Open or Outside names `prev` as its predecessor. */
export function nextState(prev: CoSignedIou | null, seq: number, change: TabChange): Iou {
  if ((prev === null) === (change.open === undefined)) throw new TabRefusal('malformed')
  if (prev) {
    if (seq <= prev.iou.seq) throw new TabRefusal('stale')
    const { debtor, creditor } = prev.iou
    const samePair =
      (equalBytes(change.debtor, debtor) && equalBytes(change.creditor, creditor)) ||
      (equalBytes(change.debtor, creditor) && equalBytes(change.creditor, debtor))
    if (!samePair) throw new TabRefusal('wrong-peer')
  }
  const base = prev ? { tab: prev.iou.tab, mint: prev.iou.mint } : change.open!
  const predecessor = prev ? contentOf(prev) : ZERO
  const iou: Iou = {
    tab: base.tab,
    seq,
    debtor: change.debtor,
    creditor: change.creditor,
    mint: base.mint,
    amount: change.amount,
    due: change.due,
    cause: change.cause,
    reference: change.cause === IouCause.Repay ? change.reference : predecessor,
    memo: change.memo,
  }
  try {
    checkIou(iou)
  } catch (error) {
    if (error instanceof ProtocolError) throw new TabRefusal('malformed')
    throw error
  }
  return iou
}

/** Every rule an offered state must pass before this phone signs it, in the order the first failure names its reason. */
export function checkOffer(state: Iou, peerSig: Uint8Array, ctx: TabContext): void {
  try {
    checkIou(state)
  } catch (error) {
    if (error instanceof ProtocolError) throw new TabRefusal('malformed')
    throw error
  }
  if (!equalBytes(state.mint, ctx.mint)) throw new TabRefusal('wrong-mint')
  const parties =
    (equalBytes(state.debtor, ctx.me) && equalBytes(state.creditor, ctx.peer)) ||
    (equalBytes(state.debtor, ctx.peer) && equalBytes(state.creditor, ctx.me))
  if (!parties) throw new TabRefusal('wrong-peer')
  if (ctx.previous) {
    if (state.seq <= ctx.previous.iou.seq) throw new TabRefusal('stale')
    try {
      checkFollows(state, ctx.previous.iou)
    } catch {
      throw new TabRefusal('not-following')
    }
  }
  if (state.seq > ctx.nextSeq + SEQ_WINDOW) throw new TabRefusal('seq-jump')
  if (state.cause === IouCause.Repay) {
    if (!equalBytes(state.creditor, ctx.me)) throw new TabRefusal('wrong-peer')
  } else {
    const named = ctx.held.some((held) => equalBytes(held, state.reference))
    if (!named && !(isZero(state.reference) && ctx.held.length === 0)) throw new TabRefusal('not-following')
  }
  try {
    verifySignature(ctx.peer, iouEnvelope(state, ctx.iouDomain), peerSig)
  } catch (error) {
    if (error instanceof ProtocolError) throw new TabRefusal('bad-signature')
    throw error
  }
  if (state.cause === IouCause.Outside && ctx.now.pending && clears(state, ctx)) throw new TabRefusal('pending')
}

/** Whether an Outside brings this phone's balance to 0 or across it. */
function clears(state: Iou, ctx: TabContext): boolean {
  const { balance } = ctx.now
  const toward = equalBytes(state.debtor, ctx.peer) ? balance : -balance
  return toward > 0n && state.amount >= toward
}

/** Runs `checkOffer`, verifies this phone's own signature and places both by role. */
export function acceptState(
  state: Iou,
  peerSig: Uint8Array,
  mine: TabContext & { signature: Uint8Array },
): CoSignedIou {
  checkOffer(state, peerSig, mine)
  try {
    verifySignature(mine.me, iouEnvelope(state, mine.iouDomain), mine.signature)
  } catch (error) {
    if (error instanceof ProtocolError) throw new TabRefusal('bad-signature')
    throw error
  }
  return equalBytes(state.debtor, mine.me)
    ? { iou: state, debtorSig: mine.signature, creditorSig: peerSig }
    : { iou: state, debtorSig: peerSig, creditorSig: mine.signature }
}

/** A netting of this tab whose record landed before `expires` (session status 4, from a chain read). `debtor` = the base direction's debtor key. */
export type AppliedNetting = {
  content: Uint8Array
  tab: Uint8Array
  baseSeq: number
  debtor: Uint8Array
  cancel: bigint
}

/**
 * A conditional repayment (`repay_notes`): `reduction` = the Repay's amount; counts only when `settled`
 * (a filed claim pays nobody, a conflicting spend is `void`); never when `settling`, `void`, `unknown` or
 * `undecided`. `payee` = the key the payment pays.
 */
export type RepayStatus = {
  tab: Uint8Array
  seq: number
  reference: Uint8Array
  payee: Uint8Array
  reduction: bigint
  status: 'settling' | 'settled' | 'void' | 'unknown' | 'undecided'
}

/** `+amount` if the change moves `me` toward being owed (it adds to what the debtor owes the creditor and `me` is the creditor), else `-amount`. */
const seenFrom = (me: Uint8Array, creditor: Uint8Array, amount: bigint) => (equalBytes(me, creditor) ? amount : -amount)

function total(
  me: Uint8Array,
  states: readonly CoSignedIou[],
  nettings: readonly AppliedNetting[],
  repays: readonly RepayStatus[],
  counted: ReadonlySet<RepayStatus['status']>,
): bigint {
  const bySeq = new Map<number, CoSignedIou>()
  const tab = states.at(0)?.iou.tab
  for (const state of states) {
    if (tab && !equalBytes(state.iou.tab, tab)) throw new TabRefusal('other-tab')
    const seen = bySeq.get(state.iou.seq)
    if (!seen) bySeq.set(state.iou.seq, state)
    else if (!equalBytes(encodeIou(seen.iou), encodeIou(state.iou))) throw new TabRefusal('malformed')
  }
  const ordered = [...bySeq.values()].sort((a, b) => a.iou.seq - b.iou.seq)
  // Alternatives on one predecessor: only the highest seq of each group counts
  const winners = new Map<string, CoSignedIou>()
  for (const state of ordered) {
    if (state.iou.cause !== IouCause.Repay) winners.set(bytesToHex(state.iou.reference), state)
  }
  const references = new Set<string>()
  let sum = 0n
  for (const state of ordered) {
    const { iou } = state
    const delta = seenFrom(me, iou.creditor, iou.amount)
    if (iou.cause === IouCause.Open) {
      if (winners.get(bytesToHex(iou.reference)) === state) sum += delta
    } else if (iou.cause === IouCause.Outside) {
      if (winners.get(bytesToHex(iou.reference)) === state) sum -= delta
    } else if (iou.cause === IouCause.Repay) {
      const key = bytesToHex(iou.reference)
      const note = repays.find((r) => equalBytes(r.reference, iou.reference))
      if (note && counted.has(note.status) && equalBytes(note.payee, iou.creditor) && !references.has(key)) {
        references.add(key)
        sum -= delta
      }
    }
  }
  const contents = new Set<string>()
  for (const netting of nettings) {
    const key = bytesToHex(netting.content)
    if (!tab || !equalBytes(netting.tab, tab) || contents.has(key)) continue
    contents.add(key)
    sum += equalBytes(me, netting.debtor) ? netting.cancel : -netting.cancel
  }
  return sum
}

const SETTLED = new Set<RepayStatus['status']>(['settled'])
const SETTLED_OR_SETTLING = new Set<RepayStatus['status']>(['settled', 'settling'])

/**
 * Signed: positive = the peer owes `me`. Counts co-signed Open/Outside (only the highest `seq` among those
 * naming one predecessor), Repays that settled and recorded nettings; each Repay reference and netting
 * content once. The states are all of one tab.
 */
export const balance = (
  me: Uint8Array,
  states: readonly CoSignedIou[],
  nettings: readonly AppliedNetting[],
  repays: readonly RepayStatus[],
): bigint => total(me, states, nettings, repays, SETTLED)

/** Same, also counting Repays still `settling` (shown as "paid, settling"). */
export const expectedBalance = (
  me: Uint8Array,
  states: readonly CoSignedIou[],
  nettings: readonly AppliedNetting[],
  repays: readonly RepayStatus[],
): bigint => total(me, states, nettings, repays, SETTLED_OR_SETTLING)
