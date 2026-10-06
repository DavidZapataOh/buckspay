import { p256 } from '@noble/curves/nist.js'
import { equalBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  type BondTicket,
  content,
  BOND_TICKET_WIRE_LEN,
  decodeBondTicket,
  ISSUE_WIRE_LEN,
  decodeIssue,
  decodeOwner,
  decodeSpend,
  encodeBondTicket,
  encodeIssue,
  encodeIssueBody,
  encodeOwner,
  encodeSpend,
  encodeSpendBody,
  envelope,
  interval,
  issueSlot,
  MAX_DEPTH,
  messageId,
  type Owner,
  type Signed,
  type Issue,
  type Spend,
} from '../protocol'
import { REASONS, type Reason } from './reasons'

export class PaymentError extends Error {
  constructor(readonly code: 'Malformed') {
    super(code)
    this.name = 'PaymentError'
  }
}
const malformed = (): never => {
  throw new PaymentError('Malformed')
}

export const MAX_MEMO_BYTES = 48
export const MAX_ATTESTERS = 8

/** What the receiver asks for and accepts, shown to the payer before anything is signed (payee-first handshake). */
export type PaymentRequest = {
  owner: Owner
  mint: Uint8Array
  amount: bigint
  /** The receiver's clock when it made the request, Unix seconds. */
  now: number
  /** The least time a received note must stay valid, seconds. */
  minWindow: number
  minHops: number
  attesters: number[]
  memo: string
  /** Whether the receiver will run a nearby check after the payment, and on which band it listens. */
  witness: 'none' | 'ultrasound' | 'audible'
}

/** Bits of the request's `flags` byte. */
export const RequestFlags = { WitnessAsked: 1, WitnessAudible: 2 } as const

const flagsOf = (witness: PaymentRequest['witness']) =>
  witness === 'none'
    ? 0
    : witness === 'ultrasound'
      ? RequestFlags.WitnessAsked
      : RequestFlags.WitnessAsked | RequestFlags.WitnessAudible

function witnessOf(flags: number): PaymentRequest['witness'] {
  if (flags === 0) return 'none'
  if (flags === RequestFlags.WitnessAsked) return 'ultrasound'
  if (flags === (RequestFlags.WitnessAsked | RequestFlags.WitnessAudible)) return 'audible'
  return malformed()
}

/** The text of `bytes` if they are valid UTF-8: invalid bytes decode to U+FFFD, which does not encode back to them. */
function strictUtf8(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes)
  if (!equalBytes(utf8ToBytes(text), bytes)) malformed()
  return text
}

export function encodeRequest(request: PaymentRequest): Uint8Array {
  const memo = utf8ToBytes(request.memo)
  const { amount, now, minWindow, minHops, attesters } = request
  if (memo.length > MAX_MEMO_BYTES || attesters.length < 1 || attesters.length > MAX_ATTESTERS) malformed()
  if (amount <= 0n || amount >= 2n ** 64n || minHops < 1 || minHops > MAX_DEPTH) malformed()
  const head = new DataView(new ArrayBuffer(33 + 32 + 8 + 4 + 4 + 1 + 1 + 1))
  const bytes = new Uint8Array(head.buffer)
  bytes.set(encodeOwner(request.owner), 0)
  bytes.set(request.mint, 33)
  head.setBigUint64(65, amount, true)
  head.setUint32(73, now, true)
  head.setUint32(77, minWindow, true)
  head.setUint8(81, minHops)
  head.setUint8(82, flagsOf(request.witness))
  head.setUint8(83, attesters.length)
  const ids = new DataView(new ArrayBuffer(2 * attesters.length))
  attesters.forEach((id, i) => ids.setUint16(2 * i, id, true))
  return concatBytes(Uint8Array.of(1), bytes, new Uint8Array(ids.buffer), Uint8Array.of(memo.length), memo)
}

export function decodeRequest(wire: Uint8Array): PaymentRequest {
  if (wire.length < 1 + 84 + 2 + 1 || wire[0] !== 1) malformed()
  const view = new DataView(wire.buffer, wire.byteOffset, wire.length)
  const base = 1
  const owner = decodeOwner(wire.slice(base, base + 33))
  const mint = wire.slice(base + 33, base + 65)
  const amount = view.getBigUint64(base + 65, true)
  const now = view.getUint32(base + 73, true)
  const minWindow = view.getUint32(base + 77, true)
  const minHops = view.getUint8(base + 81)
  const witness = witnessOf(view.getUint8(base + 82))
  const count = view.getUint8(base + 83)
  if (count < 1 || count > MAX_ATTESTERS || amount === 0n || minHops < 1 || minHops > MAX_DEPTH) malformed()
  const idsEnd = base + 84 + 2 * count
  if (wire.length < idsEnd + 1) malformed()
  const attesters = Array.from({ length: count }, (_, i) => view.getUint16(base + 84 + 2 * i, true))
  const memoLength = wire[idsEnd]
  if (memoLength > MAX_MEMO_BYTES || wire.length !== idsEnd + 1 + memoLength) malformed()
  const memo = strictUtf8(wire.subarray(idsEnd + 1))
  return { owner, mint, amount, now, minWindow, minHops, attesters, memo, witness }
}

export type Bundle = { issue: Signed<Issue>; spends: Signed<Spend>[]; tickets: BondTicket[] }

const SPEND_LENGTH = { 0x02: 178, 0x03: 219 } as const

export function encodeBundle({ issue, spends, tickets }: Bundle): Uint8Array {
  if (spends.length > MAX_DEPTH || tickets.length > spends.length + 1) malformed()
  return concatBytes(
    Uint8Array.of(1, spends.length, tickets.length),
    encodeIssue(issue),
    ...spends.map(encodeSpend),
    ...tickets.map(encodeBondTicket),
  )
}

/** Strict: exact lengths, no trailing bytes, the counts the protocol allows, every message through its own decoder. */
export function decodeBundle(wire: Uint8Array): Bundle {
  if (wire.length < 3 + ISSUE_WIRE_LEN || wire[0] !== 1) malformed()
  const [, spendCount, ticketCount] = wire
  if (spendCount > MAX_DEPTH || ticketCount > spendCount + 1) malformed()
  let at = 3
  const take = (length: number) => {
    if (at + length > wire.length) malformed()
    const part = wire.slice(at, at + length)
    at += length
    return part
  }
  const issue = decodeIssue(take(ISSUE_WIRE_LEN))
  const spends: Signed<Spend>[] = []
  for (let i = 0; i < spendCount; i++) {
    const kind = wire[at + 33]
    const length = SPEND_LENGTH[kind as keyof typeof SPEND_LENGTH]
    if (length === undefined) malformed()
    spends.push(decodeSpend(take(length)))
  }
  const tickets = Array.from({ length: ticketCount }, () => decodeBondTicket(take(BOND_TICKET_WIRE_LEN)))
  if (at !== wire.length) malformed()
  return { issue, spends, tickets }
}

/** The id of the payment: the message id of its last message, the one a receipt names. */
export function paymentId(noteDomain: Uint8Array, { issue, spends }: Pick<Bundle, 'issue' | 'spends'>): Uint8Array {
  const last = spends.at(-1)
  if (last) return messageId(envelope(noteDomain, last.message.input, content(encodeSpendBody(last.message))))
  const [start, end] = interval(issue.message)
  return messageId(
    envelope(noteDomain, issueSlot(issue.message.lockSeq, start, end), content(encodeIssueBody(issue.message))),
  )
}

export type Receipt = { accepted: boolean; reason: Reason; messageId: Uint8Array }

export const encodeReceipt = ({ accepted, reason, messageId }: Receipt) =>
  concatBytes(Uint8Array.of(1, accepted ? 0 : 1, reason), messageId)

export function decodeReceipt(wire: Uint8Array): Receipt {
  if (wire.length !== 35 || wire[0] !== 1 || wire[1] > 1 || !REASONS.has(wire[2])) malformed()
  const accepted = wire[1] === 0
  if (accepted !== (wire[2] === 0)) malformed()
  return { accepted, reason: wire[2] as Reason, messageId: wire.slice(3) }
}

const HIDDEN_RANGES = [
  [0x0, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
] as const
const HIDDEN = new RegExp(
  `[${HIDDEN_RANGES.map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join('')}]`,
  'gu',
)

/** The memo as it may be shown: no control, bidirectional or zero-width characters, one line, trimmed. */
export const sanitizeMemo = (memo: string) => memo.replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim()

const SAFETY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Eight characters both phones show for the same key, to compare by eye; a check against mix-ups, not a proof. */
export function safetyCode(owner: Owner): string {
  const digest = sha256(concatBytes(utf8ToBytes('BPSC1'), encodeOwner(owner)))
  let bits = 0n
  for (const byte of digest.slice(0, 5)) bits = (bits << 8n) | BigInt(byte)
  let code = ''
  for (let i = 7; i >= 0; i--) code += SAFETY_ALPHABET[Number((bits >> BigInt(5 * i)) & 31n)]
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

export const isDeviceKeyOnCurve = (owner: Owner) =>
  owner.type !== 'device' || p256.utils.isValidPublicKey(owner.key, true)

/** The first 8 bytes of the SHA-256 of the request's bytes: the same request is paid once. */
export const requestIdOf = (request: PaymentRequest) => sha256(encodeRequest(request)).slice(0, 8)
