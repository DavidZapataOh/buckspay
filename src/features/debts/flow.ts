import { equalBytes } from '@noble/curves/utils.js'
import { type CoSignedIou, content, encodeIou, IouCause, type Iou } from '../../protocol'
import type { Transport } from '../../transport/types'
import type { NoteDb } from '../notes/db'
import {
  type Answerer,
  answerOffers,
  DeclineReason,
  encodeDebtMessage,
  letPeerListen,
  MAX_STATES_PER_FRAME,
  type OfferView,
  offerChange,
  type OutgoingOffer,
  TabDeclined,
} from './exchange'
import {
  coSignedStates,
  latestFinal,
  openTab,
  pendingProposal,
  reserveSeq,
  saveCoSigned,
  saveCoSignedRepay,
  saveProposal,
  tabById,
  tabNow,
  tabSecret,
  tabWith,
  takeNextSeq,
} from './store'
import { intentChange, memoHash, nextState, TabRefusal, type TabChange, type TabIntent, type TabNow } from './tab'

export type DebtsContext = {
  db: NoteDb
  me: Uint8Array
  mint: Uint8Array
  iouDomain: Uint8Array
  /** Signs a tab state with this device key (`signIouBody`). */
  sign(body: Uint8Array): Promise<Uint8Array>
  now(): number
  random(n: number): Uint8Array
}

const ZERO = new Uint8Array(32)
const IDLE: TabNow = { balance: 0n, pending: false }
const contentOf = (state: CoSignedIou | null) => (state ? content(encodeIou(state.iou)) : ZERO)

/** Stores the verified states the friend's phone handed back; a state that contradicts one held is not adopted. */
const adopter = (ctx: DebtsContext) => async (states: CoSignedIou[]) => {
  for (const state of states) {
    if (!(await tabById(ctx.db, state.iou.tab))) continue
    try {
      await saveCoSigned(ctx.db, state, ctx.now())
    } catch (error) {
      if (!(error instanceof TabRefusal)) throw error
    }
  }
}

type Offer = Pick<OutgoingOffer, 'body' | 'signature' | 'finalContent' | 'secret' | 'memo'>

/**
 * Offers `offer` and returns the state both phones signed. When the friend's phone is behind it gets this phone's
 * states and the same offer once more; when it was ahead and handed states back, the outdated offer is left behind
 * (one `seq` is taken) and the person decides again against the new balance.
 */
async function send(ctx: DebtsContext, transport: Transport, tab: Uint8Array, offer: Offer, signal: AbortSignal) {
  let adopted = 0
  const adopt = adopter(ctx)
  const outgoing: OutgoingOffer = {
    ...offer,
    me: ctx.me,
    iouDomain: ctx.iouDomain,
    adopt: async (states) => {
      adopted += states.length
      await adopt(states)
    },
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await offerChange(transport, outgoing, signal)
    } catch (error) {
      if (!(error instanceof TabDeclined)) throw error
      if (error.reason === DeclineReason.Behind && attempt === 0) {
        const states = await coSignedStates(ctx.db, tab)
        for (let at = 0; at < states.length; at += MAX_STATES_PER_FRAME) {
          await transport.send(encodeDebtMessage({ type: 0x04, states: states.slice(at, at + MAX_STATES_PER_FRAME) }), {
            signal,
          })
          await letPeerListen()
        }
        continue
      }
      if (error.reason === DeclineReason.Stale && adopted > 0) {
        await takeNextSeq(ctx.db, tab)
        throw new TabRefusal('stale')
      }
      throw error
    }
  }
}

/** The tab secret travels with the offer while this phone holds no co-signed state of the tab. */
async function firstSecret(ctx: DebtsContext, tab: Uint8Array, previous: CoSignedIou | null) {
  return previous ? null : tabSecret(ctx.db, tab)
}

const withOpen = (change: TabChange, previous: CoSignedIou | null, tab: Uint8Array, mint: Uint8Array): TabChange =>
  previous ? change : { ...change, open: { tab, mint } }

/**
 * Offers the change a person asked for and returns the co-signed state. The seq is taken (and stored) before
 * anything is signed; a pending offer must be sent again or replaced first (`TabRefusal('stale')`).
 */
export async function proposeTabChange(
  ctx: DebtsContext,
  transport: Transport,
  peer: Uint8Array,
  intent: TabIntent,
  signal: AbortSignal,
): Promise<CoSignedIou> {
  const existing = await tabWith(ctx.db, peer, ctx.mint)
  if (existing && (await pendingProposal(ctx.db, existing.tab))) throw new TabRefusal('stale')
  const now = existing ? await tabNow(ctx.db, ctx.me, existing.tab) : IDLE
  const change = intentChange(ctx.me, peer, intent, now)
  const row =
    existing ??
    (await openTab(ctx.db, { tab: ctx.random(32), secret: ctx.random(32), peer, mint: ctx.mint }, ctx.now()))
  const previous = await latestFinal(ctx.db, row.tab)
  const seq = await takeNextSeq(ctx.db, row.tab)
  const iou = nextState(previous, seq, withOpen(change, previous, row.tab, ctx.mint))
  const body = encodeIou(iou)
  const signature = await ctx.sign(body)
  await saveProposal(ctx.db, { iou, signature, memo: intent.memo }, ctx.now())
  const secret = await firstSecret(ctx, row.tab, previous)
  const signed = await send(
    ctx,
    transport,
    row.tab,
    { body, signature, finalContent: contentOf(previous), secret, memo: intent.memo },
    signal,
  )
  await saveCoSigned(ctx.db, signed, ctx.now(), intent.memo)
  return signed
}

/** Offers the pending proposal again, unchanged: its body, its signature, its note and, while it is the first, the secret. */
export async function resendPending(
  ctx: DebtsContext,
  transport: Transport,
  tab: Uint8Array,
  signal: AbortSignal,
): Promise<CoSignedIou> {
  const pending = await pendingProposal(ctx.db, tab)
  const signature = pending && (pending.debtorSig ?? pending.creditorSig)
  if (!pending || !signature) throw new TabRefusal('stale')
  const previous = await latestFinal(ctx.db, tab)
  const offer = {
    body: encodeIou(pending.iou),
    signature,
    finalContent: contentOf(previous),
    secret: await firstSecret(ctx, tab, previous),
    memo: pending.memo,
  }
  const signed = await send(ctx, transport, tab, offer, signal)
  await saveCoSigned(ctx.db, signed, ctx.now(), pending.memo)
  return signed
}

/** A payment the debtor built and signed but holds (stored as not yet sent); `release` sends it over the session's transport. */
export type HeldPayment = {
  messageId: Uint8Array
  amount: bigint
  request: Uint8Array
  release(signal: AbortSignal): Promise<void>
}

/**
 * Offers a Repay naming the held payment. The payment is released only after the co-signed Repay and its repayment
 * note are stored: a decline, a timeout or a lost accept releases nothing.
 */
export async function proposeRepay(
  ctx: DebtsContext,
  transport: Transport,
  peer: Uint8Array,
  held: HeldPayment,
  signal: AbortSignal,
): Promise<CoSignedIou> {
  const row = await tabWith(ctx.db, peer, ctx.mint)
  const previous = row && (await latestFinal(ctx.db, row.tab))
  if (!row || !previous) throw new TabRefusal('not-following')
  if (await pendingProposal(ctx.db, row.tab)) throw new TabRefusal('stale')
  const seq = await takeNextSeq(ctx.db, row.tab)
  const iou = nextState(previous, seq, {
    debtor: ctx.me,
    creditor: peer,
    amount: held.amount,
    due: 0,
    cause: IouCause.Repay,
    reference: held.messageId,
    memo: memoHash(null),
  })
  const body = encodeIou(iou)
  const signature = await ctx.sign(body)
  await saveProposal(ctx.db, { iou, signature, memo: null }, ctx.now())
  const signed = await send(
    ctx,
    transport,
    row.tab,
    { body, signature, finalContent: contentOf(previous), secret: null, memo: null },
    signal,
  )
  const note = {
    tab: row.tab,
    seq: iou.seq,
    reference: held.messageId,
    payee: peer,
    reduction: held.amount,
    request: held.request,
  }
  await saveCoSignedRepay(ctx.db, signed, note, ctx.now())
  await held.release(signal)
  return signed
}

const otherParty = (state: Iou, me: Uint8Array) => (equalBytes(state.debtor, me) ? state.creditor : state.debtor)

/** Answers the next offer on `transport`: the co-signed state when the person signs, `null` when the offer is declined. */
export function answerTabOffer(
  ctx: DebtsContext,
  transport: Transport,
  review: (view: OfferView) => Promise<boolean>,
  signal: AbortSignal,
): Promise<CoSignedIou | null> {
  const answerer: Answerer = {
    me: ctx.me,
    mint: ctx.mint,
    iouDomain: ctx.iouDomain,
    async load(tab, peer) {
      const [byPeer, byId] = [await tabWith(ctx.db, peer, ctx.mint), await tabById(ctx.db, tab)]
      const otherTab =
        (byPeer !== null && !equalBytes(byPeer.tab, tab)) || (byId !== null && !equalBytes(byId.peer, peer))
      if (!byPeer || otherTab) return { states: [], nextSeq: 1, now: IDLE, locked: false, otherTab }
      return {
        states: await coSignedStates(ctx.db, tab),
        nextSeq: byPeer.nextSeq,
        now: await tabNow(ctx.db, ctx.me, tab),
        locked: byPeer.lockedBy !== null,
        otherTab: false,
      }
    },
    adopt: adopter(ctx),
    review,
    sign: ctx.sign,
    async reserve(state, secret) {
      const peer = otherParty(state, ctx.me)
      if (!(await tabWith(ctx.db, peer, ctx.mint))) {
        if (!secret) throw new TabRefusal('other-tab')
        await openTab(ctx.db, { tab: state.tab, secret, peer, mint: ctx.mint }, ctx.now())
      }
      await reserveSeq(ctx.db, state.tab, state.seq)
    },
    async save(signed, memo) {
      const { iou } = signed
      if (iou.cause === IouCause.Repay) {
        const note = {
          tab: iou.tab,
          seq: iou.seq,
          reference: iou.reference,
          payee: ctx.me,
          reduction: iou.amount,
          request: null,
        }
        await saveCoSignedRepay(ctx.db, signed, note, ctx.now(), memo)
      } else {
        await saveCoSigned(ctx.db, signed, ctx.now(), memo)
      }
    },
  }
  return answerOffers(transport, answerer, signal)
}
