import { equalBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { checkBytes, checkU32, checkU64, Kind, ProtocolError, VERSION } from './codec'
import { content, envelope } from './hash'
import { primeOrder } from './ticket'
import { verifySignature } from './verify'

export const IOU_BODY_LEN = 213
export const IOU_WIRE_LEN = 341
export const JOIN_BODY_LEN = 99

const IOU_SLOT_TAG = utf8ToBytes('IOUS')
const JOIN_SLOT_TAG = utf8ToBytes('NETJ')

/** Why a state exists. `Netting` is reserved: a netting is recorded on chain and never signed as a state. */
export const IouCause = { Open: 1, Repay: 2, Netting: 3, Outside: 4 } as const
export type IouCauseValue = (typeof IouCause)[keyof typeof IouCause]

/** One change of a tab (`amount` ≥ 1): Open adds to the debt, Repay and Outside subtract. */
export type Iou = {
  tab: Uint8Array
  seq: number
  debtor: Uint8Array
  creditor: Uint8Array
  mint: Uint8Array
  amount: bigint
  due: number
  cause: IouCauseValue
  /** Repay: the payment's message id. Open and Outside: the content of the proposer's latest co-signed state. */
  reference: Uint8Array
  memo: Uint8Array
}
export type CoSignedIou = { iou: Iou; debtorSig: Uint8Array; creditorSig: Uint8Array }
export type NettingJoin = { session: Uint8Array; ephemeral: Uint8Array; key: Uint8Array }

const compressed = (key: Uint8Array) => {
  if (key[0] !== 0x02 && key[0] !== 0x03) throw new ProtocolError('Owner')
}

/** The rules of the Rust `Iou::check`, in the same order. */
export function checkIou(iou: Iou): void {
  checkBytes(iou.tab, 32)
  checkBytes(iou.debtor, 33)
  checkBytes(iou.creditor, 33)
  checkBytes(iou.mint, 32)
  checkBytes(iou.reference, 32)
  checkBytes(iou.memo, 32)
  checkU32(iou.seq)
  checkU32(iou.due)
  checkU64(iou.amount)
  if (iou.seq === 0) throw new ProtocolError('Linkage')
  compressed(iou.debtor)
  compressed(iou.creditor)
  if (equalBytes(iou.debtor, iou.creditor)) throw new ProtocolError('Owner')
  const { cause } = iou
  const reference = cause === IouCause.Repay && iou.reference.some((byte) => byte !== 0)
  if (cause !== IouCause.Open && cause !== IouCause.Outside && !reference) throw new ProtocolError('Kind')
  if (iou.amount === 0n) throw new ProtocolError('Amount')
}

export function encodeIou(iou: Iou): Uint8Array {
  checkIou(iou)
  return bodyOf(iou)
}

/** The wire body without the rules, like the Rust `Iou::body`: a verifier runs `checkIou` before it trusts one. */
function bodyOf(iou: Iou): Uint8Array {
  const out = new Uint8Array(IOU_BODY_LEN)
  const view = new DataView(out.buffer)
  out[0] = VERSION
  out[1] = Kind.Iou
  out.set(iou.tab, 2)
  view.setUint32(34, iou.seq, true)
  out.set(iou.debtor, 38)
  out.set(iou.creditor, 71)
  out.set(iou.mint, 104)
  view.setBigUint64(136, iou.amount, true)
  view.setUint32(144, iou.due, true)
  out[148] = iou.cause
  out.set(iou.reference, 149)
  out.set(iou.memo, 181)
  return out
}

/** The fields of a body of the right length, version and kind, without the rules of `checkIou`. */
export function parseIou(body: Uint8Array): Iou {
  if (body.length !== IOU_BODY_LEN) throw new ProtocolError('Length')
  if (body[0] !== VERSION) throw new ProtocolError('Version')
  if (body[1] !== Kind.Iou) throw new ProtocolError('Kind')
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const iou: Iou = {
    tab: body.slice(2, 34),
    seq: view.getUint32(34, true),
    debtor: body.slice(38, 71),
    creditor: body.slice(71, 104),
    mint: body.slice(104, 136),
    amount: view.getBigUint64(136, true),
    due: view.getUint32(144, true),
    cause: body[148] as IouCauseValue,
    reference: body.slice(149, 181),
    memo: body.slice(181, 213),
  }
  return iou
}

export function decodeIou(body: Uint8Array): Iou {
  const iou = parseIou(body)
  checkIou(iou)
  return iou
}

/** `next` can come after `previous` in one tab (`null`: it is the first state, so only `seq ≥ 1`); gaps in `seq` are allowed. */
export function checkFollows(next: Iou, previous: Iou | null): void {
  if (previous === null) {
    if (next.seq < 1) throw new ProtocolError('Linkage')
    return
  }
  const samePair =
    (equalBytes(next.debtor, previous.debtor) && equalBytes(next.creditor, previous.creditor)) ||
    (equalBytes(next.debtor, previous.creditor) && equalBytes(next.creditor, previous.debtor))
  if (
    !equalBytes(next.tab, previous.tab) ||
    next.seq <= previous.seq ||
    !equalBytes(next.mint, previous.mint) ||
    !samePair
  )
    throw new ProtocolError('Linkage')
}

export function iouSlot(tab: Uint8Array, seq: number): Uint8Array {
  checkBytes(tab, 32)
  checkU32(seq)
  const seqLe = new Uint8Array(4)
  new DataView(seqLe.buffer).setUint32(0, seq, true)
  return sha256(concatBytes(IOU_SLOT_TAG, tab, seqLe))
}

export const iouEnvelope = (iou: Iou, iouDomain: Uint8Array): Uint8Array =>
  envelope(iouDomain, iouSlot(iou.tab, iou.seq), content(bodyOf(iou)))

export function encodeCoSigned({ iou, debtorSig, creditorSig }: CoSignedIou): Uint8Array {
  checkBytes(debtorSig, 64)
  checkBytes(creditorSig, 64)
  return concatBytes(encodeIou(iou), debtorSig, creditorSig)
}

export function decodeCoSigned(bytes: Uint8Array): CoSignedIou {
  if (bytes.length !== IOU_WIRE_LEN) throw new ProtocolError('Length')
  return {
    iou: decodeIou(bytes.subarray(0, IOU_BODY_LEN)),
    debtorSig: bytes.slice(213, 277),
    creditorSig: bytes.slice(277, 341),
  }
}

function accepted(check: () => void): boolean {
  try {
    check()
    return true
  } catch (error) {
    if (error instanceof ProtocolError) return false
    throw error
  }
}

/** Both signatures verify over the state's envelope under `iouDomain`; any protocol error is `false`. */
export function verifyCoSigned(state: CoSignedIou, iouDomain: Uint8Array): boolean {
  return accepted(() => {
    const message = iouEnvelope(state.iou, iouDomain)
    verifySignature(state.iou.debtor, message, state.debtorSig)
    verifySignature(state.iou.creditor, message, state.creditorSig)
  })
}

export function encodeJoin(join: NettingJoin): Uint8Array {
  checkBytes(join.session, 32)
  checkBytes(join.ephemeral, 32)
  checkBytes(join.key, 33)
  compressed(join.key)
  return concatBytes(Uint8Array.of(VERSION, Kind.NettingJoin), join.session, join.ephemeral, join.key)
}

export function decodeJoin(body: Uint8Array): NettingJoin {
  if (body.length !== JOIN_BODY_LEN) throw new ProtocolError('Length')
  if (body[0] !== VERSION) throw new ProtocolError('Version')
  if (body[1] !== Kind.NettingJoin) throw new ProtocolError('Kind')
  const join = { session: body.slice(2, 34), ephemeral: body.slice(34, 66), key: body.slice(66, 99) }
  compressed(join.key)
  return join
}

export function joinSlot(session: Uint8Array): Uint8Array {
  checkBytes(session, 32)
  return sha256(concatBytes(JOIN_SLOT_TAG, session))
}

/** The join is signed by its device key under `iouDomain`, and its ephemeral key is of prime order (the strict rule every netting verifier applies). */
export function verifyJoin(body: Uint8Array, signature: Uint8Array, iouDomain: Uint8Array): boolean {
  return accepted(() => {
    const join = decodeJoin(body)
    if (!primeOrder(join.ephemeral)) throw new ProtocolError('Signer')
    verifySignature(join.key, envelope(iouDomain, joinSlot(join.session), content(body)), signature)
  })
}
