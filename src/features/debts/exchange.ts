import { equalBytes } from '@noble/curves/utils.js'
import { concatBytes } from '@noble/hashes/utils.js'
import {
  type CoSignedIou,
  content,
  decodeCoSigned,
  decodeIou,
  parseIou,
  encodeCoSigned,
  encodeIou,
  type Iou,
  IOU_BODY_LEN,
  IOU_WIRE_LEN,
  iouEnvelope,
  Kind,
  ProtocolError,
  verifyCoSigned,
  verifySignature,
  VERSION,
} from '../../protocol'
import { type Message, MessageKind, type Transport, TransportError } from '../../transport/types'
import { checkOffer, MAX_MEMO_BYTES, memoHash, acceptState, TabRefusal, type TabContext, type TabNow } from './tab'

/** The inner type, the first byte of a debt message's payload. 0x10 to 0x1A belong to nettings. */
export const DebtMessageType = { TabOffer: 0x01, TabAccept: 0x02, TabDecline: 0x03, TabStates: 0x04 } as const
export const OfferFlags = { First: 0x01 } as const
export const DeclineReason = { Declined: 1, Invalid: 2, Locked: 3, Stale: 4, OtherTab: 5, Behind: 6 } as const

export type TabOffer = {
  body: Uint8Array
  signature: Uint8Array
  /** The content of the proposer's latest co-signed state of the tab, zero when it has none. */
  finalContent: Uint8Array
  /** The tab secret, present while the proposer holds no co-signed state (`First`). */
  secret: Uint8Array | null
  memo: string | null
}

export const MAX_STATES_PER_FRAME = 24
export const OFFER_WAIT_MS = 120_000

export type DebtMessage =
  | { type: 0x01; offer: TabOffer }
  | { type: 0x02; content: Uint8Array; signature: Uint8Array }
  | { type: 0x03; content: Uint8Array; reason: number }
  | { type: 0x04; states: CoSignedIou[] }

export class TabDeclined extends Error {
  constructor(readonly reason: number) {
    super(`The offer was declined (${reason})`)
    this.name = 'TabDeclined'
  }
}

const OFFER_FIXED = 1 + IOU_BODY_LEN + 64 + 32 + 1
const SECRET_LEN = 32

export function encodeDebtMessage(message: DebtMessage): Message {
  const payload = (() => {
    switch (message.type) {
      case 0x01: {
        const { offer } = message
        const memo = new TextEncoder().encode(offer.memo ?? '')
        if (memo.length > MAX_MEMO_BYTES) throw new ProtocolError('Length')
        const flags = offer.secret ? OfferFlags.First : 0
        return concatBytes(
          Uint8Array.of(0x01),
          offer.body,
          offer.signature,
          offer.finalContent,
          Uint8Array.of(flags),
          offer.secret ?? new Uint8Array(),
          Uint8Array.of(memo.length),
          memo,
        )
      }
      case 0x02:
        return concatBytes(Uint8Array.of(0x02), message.content, message.signature)
      case 0x03:
        return concatBytes(Uint8Array.of(0x03), message.content, Uint8Array.of(message.reason))
      case 0x04:
        if (message.states.length < 1 || message.states.length > MAX_STATES_PER_FRAME) throw new ProtocolError('Length')
        return concatBytes(Uint8Array.of(0x04, message.states.length), ...message.states.map(encodeCoSigned))
    }
  })()
  return { kind: MessageKind.Debts, payload }
}

export function decodeDebtMessage(message: Message): DebtMessage {
  if (message.kind !== MessageKind.Debts) throw new ProtocolError('Kind')
  const p = message.payload
  if (p.length === 0) throw new ProtocolError('Length')
  switch (p[0]) {
    case 0x01:
      return { type: 0x01, offer: decodeOffer(p) }
    case 0x02:
      if (p.length !== 97) throw new ProtocolError('Length')
      return { type: 0x02, content: p.slice(1, 33), signature: p.slice(33, 97) }
    case 0x03:
      if (p.length !== 34) throw new ProtocolError('Length')
      if (p[33] < DeclineReason.Declined || p[33] > DeclineReason.Behind) throw new ProtocolError('Kind')
      return { type: 0x03, content: p.slice(1, 33), reason: p[33] }
    case 0x04: {
      const count = p[1]
      if (p.length < 2 || count < 1 || count > MAX_STATES_PER_FRAME || p.length !== 2 + count * IOU_WIRE_LEN)
        throw new ProtocolError('Length')
      const states = Array.from({ length: count }, (_, i) =>
        decodeCoSigned(p.subarray(2 + i * IOU_WIRE_LEN, 2 + (i + 1) * IOU_WIRE_LEN)),
      )
      return { type: 0x04, states }
    }
    default:
      throw new ProtocolError('Kind')
  }
}

function decodeOffer(p: Uint8Array): TabOffer {
  if (p.length < OFFER_FIXED) throw new ProtocolError('Length')
  const flags = p[OFFER_FIXED - 1]
  if (flags & ~OfferFlags.First) throw new ProtocolError('Flags')
  const secretLen = flags & OfferFlags.First ? SECRET_LEN : 0
  const memoLenAt = OFFER_FIXED + secretLen
  if (p.length <= memoLenAt) throw new ProtocolError('Length')
  const memoLen = p[memoLenAt]
  if (memoLen > MAX_MEMO_BYTES || p.length !== memoLenAt + 1 + memoLen) throw new ProtocolError('Length')
  if (p[1] !== VERSION) throw new ProtocolError('Version')
  if (p[2] !== Kind.Iou) throw new ProtocolError('Kind')
  let memo: string | null = null
  if (memoLen > 0) {
    try {
      memo = new TextDecoder('utf-8', { fatal: true }).decode(p.subarray(memoLenAt + 1))
    } catch {
      throw new ProtocolError('Length')
    }
  }
  return {
    body: p.slice(1, 1 + IOU_BODY_LEN),
    signature: p.slice(1 + IOU_BODY_LEN, 1 + IOU_BODY_LEN + 64),
    finalContent: p.slice(1 + IOU_BODY_LEN + 64, OFFER_FIXED - 1),
    secret: secretLen ? p.slice(OFFER_FIXED, OFFER_FIXED + SECRET_LEN) : null,
    memo,
  }
}

export type OutgoingOffer = TabOffer & {
  me: Uint8Array
  iouDomain: Uint8Array
  /** Stores the verified co-signed states the friend's phone sent back (healing). */
  adopt(states: CoSignedIou[]): Promise<void>
}

/**
 * Keeps one receive armed on `transport` for debt messages and arms the next as soon as a message arrives, so the
 * friend's phone is never left talking to nobody while this one works. `stop` cancels what is still armed.
 */
function listen(transport: Transport, signal: AbortSignal, deadline?: number) {
  const own = new AbortController()
  const relay = () => own.abort()
  signal.addEventListener('abort', relay)
  const arm = () => {
    const timeoutMs = deadline === undefined ? undefined : deadline - Date.now()
    if (timeoutMs !== undefined && timeoutMs <= 0) return Promise.reject(new TransportError('Timeout'))
    return transport.receive({ signal: own.signal, timeoutMs, accept: [MessageKind.Debts] })
  }
  let waiting = arm()
  return {
    async next(): Promise<Message> {
      const message = await waiting
      waiting = arm()
      return message
    },
    stop() {
      signal.removeEventListener('abort', relay)
      own.abort()
      waiting.catch(() => undefined)
    },
  }
}

/** Lets the friend's phone arm its receive again before the next frame leaves. */
export const letPeerListen = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const decoded = (message: Message): DebtMessage | undefined => {
  try {
    return decodeDebtMessage(message)
  } catch (error) {
    if (error instanceof ProtocolError) return undefined
    throw error
  }
}

/** The pair, tab and mint of `state` match `of`. */
function sameTab(state: Iou, of: Iou): boolean {
  const pair =
    (equalBytes(state.debtor, of.debtor) && equalBytes(state.creditor, of.creditor)) ||
    (equalBytes(state.debtor, of.creditor) && equalBytes(state.creditor, of.debtor))
  return pair && equalBytes(state.tab, of.tab) && equalBytes(state.mint, of.mint)
}

/**
 * Offers a change and waits for the friend's phone: the co-signed state when it signs, `TabDeclined` when it does
 * not. It listens before it sends. Other contents, bad signatures and other message types are ignored; states the
 * friend's phone sends back are verified and handed to `adopt` first.
 */
export async function offerChange(
  transport: Transport,
  offer: OutgoingOffer,
  signal: AbortSignal,
): Promise<CoSignedIou> {
  const state = parseIou(offer.body)
  const sent = content(offer.body)
  const other = equalBytes(state.debtor, offer.me) ? state.creditor : state.debtor
  const inbox = listen(transport, signal, Date.now() + OFFER_WAIT_MS)
  try {
    const availability = await transport.check()
    if (!availability.ready) throw new TransportError('Unavailable', availability.reason)
    await transport.send(encodeDebtMessage({ type: 0x01, offer }), { signal })
    for (;;) {
      const message = decoded(await inbox.next())
      if (message?.type === 0x04) {
        const verified = message.states.filter((s) => sameTab(s.iou, state) && verifyCoSigned(s, offer.iouDomain))
        if (verified.length > 0) await offer.adopt(verified)
      } else if (message?.type === 0x02 && equalBytes(message.content, sent)) {
        if (accepts(state, message.signature, other, offer.iouDomain)) {
          const mine = offer.signature
          return equalBytes(state.debtor, offer.me)
            ? { iou: state, debtorSig: mine, creditorSig: message.signature }
            : { iou: state, debtorSig: message.signature, creditorSig: mine }
        }
      } else if (message?.type === 0x03 && equalBytes(message.content, sent)) {
        throw new TabDeclined(message.reason)
      }
    }
  } finally {
    inbox.stop()
  }
}

function accepts(state: Iou, signature: Uint8Array, key: Uint8Array, iouDomain: Uint8Array): boolean {
  try {
    verifySignature(key, iouEnvelope(state, iouDomain), signature)
    return true
  } catch (error) {
    if (error instanceof ProtocolError) return false
    throw error
  }
}

/** What the person is asked to sign: the offered change, the balance now (+ = the friend owes me) and the note. */
export type OfferView = {
  state: Iou
  previous: CoSignedIou | null
  balance: bigint
  memo: string | null
  first: boolean
}

/** What the answering side needs from the store and the person; `flow.ts` wires it to the database. */
export type Answerer = {
  me: Uint8Array
  mint: Uint8Array
  iouDomain: Uint8Array
  load(
    tab: Uint8Array,
    peer: Uint8Array,
  ): Promise<{
    /** Every co-signed state of the tab, `seq` ascending. */
    states: CoSignedIou[]
    nextSeq: number
    now: TabNow
    locked: boolean
    otherTab: boolean
  }>
  /** Stores the verified co-signed states the proposer sent (healing). */
  adopt(states: CoSignedIou[]): Promise<void>
  review(view: OfferView): Promise<boolean>
  sign(body: Uint8Array): Promise<Uint8Array>
  /** Opens the tab if new and reserves `seq`; runs before `sign`. */
  reserve(state: Iou, secret: Uint8Array | null): Promise<void>
  /** Writes the co-signed state (and, for a Repay, its repayment note); runs before the accept is sent. */
  save(state: CoSignedIou, memo: string | null): Promise<void>
}

const chunks = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))

/**
 * Answers one offer received on `transport`: the co-signed state once the person signs, `null` when the offer is
 * declined. Everything is written before the accept leaves, so a lost accept is repaired by the proposer sending
 * the same offer again. Missing states are exchanged first (healing, one round per call).
 */
export async function answerOffers(
  transport: Transport,
  decide: Answerer,
  signal: AbortSignal,
): Promise<CoSignedIou | null> {
  const inbox = listen(transport, signal)
  let healed = false
  try {
    for (;;) {
      const message = decoded(await inbox.next())
      if (message?.type === 0x04) {
        const states = message.states.filter(
          (s) =>
            verifyCoSigned(s, decide.iouDomain) && equalBytes(s.iou.mint, decide.mint) && involves(s.iou, decide.me),
        )
        if (states.length > 0) await decide.adopt(states)
      } else if (message?.type === 0x01) {
        const result = await answerOne(transport, decide, message.offer, signal, healed)
        if (result !== 'behind') return result
        healed = true
      }
    }
  } finally {
    inbox.stop()
  }
}

const involves = (state: Iou, key: Uint8Array) => equalBytes(state.debtor, key) || equalBytes(state.creditor, key)

async function answerOne(
  transport: Transport,
  decide: Answerer,
  offer: TabOffer,
  signal: AbortSignal,
  healed: boolean,
): Promise<CoSignedIou | null | 'behind'> {
  const sent = content(offer.body)
  const decline = async (reason: number) => {
    await transport.send(encodeDebtMessage({ type: 0x03, content: sent, reason }), { signal })
    return null
  }
  let state: Iou
  try {
    state = decodeIou(offer.body)
  } catch (error) {
    if (error instanceof ProtocolError) return decline(DeclineReason.Invalid)
    throw error
  }
  if (!involves(state, decide.me)) return decline(DeclineReason.Invalid)
  const peer = equalBytes(state.debtor, decide.me) ? state.creditor : state.debtor
  const loaded = await decide.load(state.tab, peer)
  const mySignature = (signed: CoSignedIou) =>
    equalBytes(signed.iou.debtor, decide.me) ? signed.debtorSig : signed.creditorSig
  const stored = loaded.states.find((s) => equalBytes(encodeIou(s.iou), offer.body))
  if (stored) {
    await transport.send(encodeDebtMessage({ type: 0x02, content: sent, signature: mySignature(stored) }), { signal })
    return stored
  }
  if (loaded.locked) return decline(DeclineReason.Locked)
  if (loaded.otherTab) return decline(DeclineReason.OtherTab)

  const { states } = loaded
  const known = states.length > 0 || loaded.nextSeq > 1
  const latest = states.at(-1)
  const finalIsZero = offer.finalContent.every((byte) => byte === 0)
  const at = finalIsZero ? -1 : states.findIndex((s) => equalBytes(content(encodeIou(s.iou)), offer.finalContent))
  if (latest && (finalIsZero || (at >= 0 && at < states.length - 1))) {
    for (const frame of chunks(states.slice(at + 1), MAX_STATES_PER_FRAME)) {
      await transport.send(encodeDebtMessage({ type: 0x04, states: frame }), { signal })
      await letPeerListen()
    }
    return decline(DeclineReason.Stale)
  }
  if (!finalIsZero && at < 0) {
    if (healed) return decline(DeclineReason.Behind)
    await decline(DeclineReason.Behind)
    return 'behind'
  }
  const first = offer.secret !== null
  if (first === known) return decline(DeclineReason.Invalid)
  const memoMatches =
    offer.memo === null ? state.memo.every((byte) => byte === 0) : equalBytes(memoHash(offer.memo), state.memo)
  if (!memoMatches) return decline(DeclineReason.Invalid)

  const ctx: TabContext = {
    me: decide.me,
    peer,
    mint: decide.mint,
    previous: latest ?? null,
    held: states.map((s) => content(encodeIou(s.iou))),
    nextSeq: loaded.nextSeq,
    now: loaded.now,
    iouDomain: decide.iouDomain,
  }
  try {
    checkOffer(state, offer.signature, ctx)
  } catch (error) {
    if (!(error instanceof TabRefusal)) throw error
    return decline(
      error.reason === 'stale'
        ? DeclineReason.Stale
        : error.reason === 'pending'
          ? DeclineReason.Locked
          : DeclineReason.Invalid,
    )
  }
  if (!(await decide.review({ state, previous: latest ?? null, balance: loaded.now.balance, memo: offer.memo, first })))
    return decline(DeclineReason.Declined)

  await decide.reserve(state, offer.secret)
  const signature = await decide.sign(offer.body)
  const accepted = acceptState(state, offer.signature, { ...ctx, signature })
  await decide.save(accepted, offer.memo)
  await transport.send(encodeDebtMessage({ type: 0x02, content: sent, signature }), { signal })
  return accepted
}
