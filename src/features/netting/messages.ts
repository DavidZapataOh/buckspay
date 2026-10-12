import { concatBytes } from '@noble/hashes/utils.js'
import {
  type CoSignedIou,
  decodeCoSigned,
  decodeStatement,
  encodeCoSigned,
  encodeStatement,
  IOU_WIRE_LEN,
  JOIN_BODY_LEN,
  MAX_PARTICIPANTS,
  type NettingStatement,
  ProtocolError,
  STATEMENT_BASE_LEN,
} from '../../protocol'
import { MessageKind } from '../../transport/types'
import { NETTING_PROOF_LEN } from './prove'
import { SLOTS } from './digest'
import type { Transfer } from './cycles'

export const SessionType = {
  Join: 0x10,
  Roster: 0x11,
  Tabs: 0x12,
  Proposal: 0x13,
  Approve: 0x14,
  Final: 0x15,
  Abort: 0x16,
  Relay: 0x17,
  Simplify: 0x1a,
  SimplifyApprove: 0x1b,
} as const

export const AbortReason = { Cancelled: 1, MemberLeft: 2, Timeout: 3, Refused: 4, Expired: 5, NothingToNet: 6 } as const

const SIGNATURE_LEN = 64
const SALT_LEN = 32
const DIGESTS = 8
const DIGEST_LEN = 32
const MAX_TABS = 7
const MAX_VIA = 6
const TAB_ENTRY_LEN = IOU_WIRE_LEN + SALT_LEN + 8 + 1
const ROSTER_ENTRY_LEN = 1 + JOIN_BODY_LEN + SIGNATURE_LEN
const SLOT_ENTRY_LEN = 13
const TRANSFER_HEAD_LEN = 11
const MAX_INDEX = MAX_PARTICIPANTS - 1
const KINDS: readonly number[] = Object.values(MessageKind)

export type SignedJoin = { body: Uint8Array; signature: Uint8Array }
export type SignedRosterEntry = { index: number; join: SignedJoin }
export type TabEntry = { state: CoSignedIou; salt: Uint8Array; debt: bigint; peerOwesSender: boolean; pending: boolean }
export type ProposalSlot = { slot: number; baseSeq: number; cancel: bigint }
export type Proposal = { statement: NettingStatement; digests: Uint8Array[]; slots: ProposalSlot[] }
export type { Transfer }

export type SessionMessage =
  | { type: 'Join'; join: SignedJoin }
  | { type: 'Roster'; entries: SignedRosterEntry[] }
  | { type: 'Tabs'; tabs: TabEntry[] }
  | { type: 'Proposal'; proposal: Proposal }
  | { type: 'Approve'; signature: Uint8Array }
  | { type: 'Final'; signatures: Uint8Array[]; proof: Uint8Array }
  | { type: 'Abort'; reason: number }
  | { type: 'Relay'; from: number; to: number; kind: MessageKind; payload: Uint8Array }
  | { type: 'Simplify'; transfers: Transfer[] }
  | { type: 'SimplifyApprove'; approved: number[] }

export class MessageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MessageError'
  }
}

const check = (ok: boolean, what: string) => {
  if (!ok) throw new MessageError(what)
}

function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function u64(value: bigint): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, value, true)
  return out
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return out
}

function protocol<T>(read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof ProtocolError) throw new MessageError(`protocol: ${error.code}`)
    throw error
  }
}

const encodeSignedJoin = (join: SignedJoin) => {
  check(join.body.length === JOIN_BODY_LEN && join.signature.length === SIGNATURE_LEN, 'join length')
  return concatBytes(join.body, join.signature)
}

const decodeSignedJoin = (bytes: Uint8Array): SignedJoin => ({
  body: bytes.slice(0, JOIN_BODY_LEN),
  signature: bytes.slice(JOIN_BODY_LEN),
})

export function encodeMessage(message: SessionMessage): { type: number; body: Uint8Array } {
  const type = SessionType[message.type]
  switch (message.type) {
    case 'Join':
      return { type, body: encodeSignedJoin(message.join) }
    case 'Roster':
      return {
        type,
        body: concatBytes(
          Uint8Array.of(message.entries.length),
          ...message.entries.map((entry) => concatBytes(Uint8Array.of(entry.index), encodeSignedJoin(entry.join))),
        ),
      }
    case 'Tabs':
      return {
        type,
        body: concatBytes(
          Uint8Array.of(message.tabs.length),
          ...message.tabs.map((tab) =>
            concatBytes(
              encodeCoSigned(tab.state),
              tab.salt,
              u64(tab.debt),
              Uint8Array.of((tab.peerOwesSender ? 1 : 0) | (tab.pending ? 2 : 0)),
            ),
          ),
        ),
      }
    case 'Proposal': {
      const { statement, digests, slots } = message.proposal
      check(digests.length === DIGESTS && digests.every((d) => d.length === DIGEST_LEN), 'digests')
      return {
        type,
        body: concatBytes(
          encodeStatement(statement),
          ...digests,
          Uint8Array.of(slots.length),
          ...slots.map((s) => concatBytes(Uint8Array.of(s.slot), u32(s.baseSeq), u64(s.cancel))),
        ),
      }
    }
    case 'Approve':
      check(message.signature.length === SIGNATURE_LEN, 'signature length')
      return { type, body: message.signature }
    case 'Final':
      check(
        message.proof.length === NETTING_PROOF_LEN && message.signatures.every((s) => s.length === SIGNATURE_LEN),
        'final length',
      )
      return { type, body: concatBytes(...message.signatures, message.proof) }
    case 'Abort':
      return { type, body: Uint8Array.of(message.reason) }
    case 'Relay':
      return { type, body: concatBytes(Uint8Array.of(message.from, message.to, message.kind), message.payload) }
    case 'Simplify':
      return {
        type,
        body: concatBytes(
          Uint8Array.of(message.transfers.length),
          ...message.transfers.map((t) =>
            concatBytes(Uint8Array.of(t.payer, t.payee), u64(t.amount), Uint8Array.of(t.via.length, ...t.via)),
          ),
        ),
      }
    case 'SimplifyApprove':
      return { type, body: Uint8Array.of(message.approved.length, ...message.approved) }
  }
}

function decodeProposal(body: Uint8Array): Proposal {
  check(body.length > 66, 'proposal length')
  const n = body[66]
  check(n >= 2 && n <= MAX_PARTICIPANTS, 'participants')
  const statementLen = STATEMENT_BASE_LEN + 32 * n
  const countAt = statementLen + DIGESTS * DIGEST_LEN
  check(body.length > countAt, 'proposal length')
  const count = body[countAt]
  check(count <= MAX_TABS, 'slot count')
  check(body.length === countAt + 1 + SLOT_ENTRY_LEN * count, 'proposal length')
  const statement = protocol(() => decodeStatement(body.slice(0, statementLen)))
  const digests = Array.from({ length: DIGESTS }, (_, i) =>
    body.slice(statementLen + i * DIGEST_LEN, statementLen + (i + 1) * DIGEST_LEN),
  )
  const slots = Array.from({ length: count }, (_, i) => {
    const at = countAt + 1 + i * SLOT_ENTRY_LEN
    const slot = body[at]
    check(slot < SLOTS, 'slot')
    return { slot, baseSeq: view(body).getUint32(at + 1, true), cancel: view(body).getBigUint64(at + 5, true) }
  })
  return { statement, digests, slots }
}

function decodeSimplify(body: Uint8Array): Transfer[] {
  check(body.length >= 1 && body[0] <= MAX_TABS, 'transfer count')
  const transfers: Transfer[] = []
  let at = 1
  for (let i = 0; i < body[0]; i++) {
    check(body.length >= at + TRANSFER_HEAD_LEN, 'transfer length')
    const viaLen = body[at + 10]
    check(viaLen <= MAX_VIA && body.length >= at + TRANSFER_HEAD_LEN + viaLen, 'via length')
    const via = Array.from(body.slice(at + TRANSFER_HEAD_LEN, at + TRANSFER_HEAD_LEN + viaLen))
    const payer = body[at]
    const payee = body[at + 1]
    check(payer <= MAX_INDEX && payee <= MAX_INDEX && via.every((v) => v <= MAX_INDEX), 'participant index')
    transfers.push({ payer, payee, amount: view(body).getBigUint64(at + 2, true), via })
    at += TRANSFER_HEAD_LEN + viaLen
  }
  check(at === body.length, 'trailing bytes')
  return transfers
}

/** `participants` is needed only for Final (n signatures, no length prefix). Exact lengths; trailing bytes refused. */
export function decodeMessage(type: number, body: Uint8Array, participants?: number): SessionMessage {
  switch (type) {
    case SessionType.Join:
      check(body.length === JOIN_BODY_LEN + SIGNATURE_LEN, 'join length')
      return { type: 'Join', join: decodeSignedJoin(body) }
    case SessionType.Roster: {
      check(body.length >= 1 && body[0] >= 1 && body[0] <= MAX_PARTICIPANTS, 'roster count')
      check(body.length === 1 + ROSTER_ENTRY_LEN * body[0], 'roster length')
      const entries = Array.from({ length: body[0] }, (_, i) => {
        const at = 1 + i * ROSTER_ENTRY_LEN
        check(body[at] <= MAX_INDEX, 'roster index')
        return { index: body[at], join: decodeSignedJoin(body.slice(at + 1, at + ROSTER_ENTRY_LEN)) }
      })
      return { type: 'Roster', entries }
    }
    case SessionType.Tabs: {
      check(body.length >= 1 && body[0] <= MAX_TABS, 'tab count')
      check(body.length === 1 + TAB_ENTRY_LEN * body[0], 'tabs length')
      const tabs = Array.from({ length: body[0] }, (_, i) => {
        const at = 1 + i * TAB_ENTRY_LEN
        const flags = body[at + TAB_ENTRY_LEN - 1]
        check((flags & ~3) === 0, 'tab flags')
        return {
          state: protocol(() => decodeCoSigned(body.slice(at, at + IOU_WIRE_LEN))),
          salt: body.slice(at + IOU_WIRE_LEN, at + IOU_WIRE_LEN + SALT_LEN),
          debt: view(body).getBigUint64(at + IOU_WIRE_LEN + SALT_LEN, true),
          peerOwesSender: (flags & 1) === 1,
          pending: (flags & 2) === 2,
        }
      })
      return { type: 'Tabs', tabs }
    }
    case SessionType.Proposal:
      return { type: 'Proposal', proposal: decodeProposal(body) }
    case SessionType.Approve:
      check(body.length === SIGNATURE_LEN, 'approve length')
      return { type: 'Approve', signature: body.slice() }
    case SessionType.Final: {
      if (participants === undefined || participants < 2 || participants > MAX_PARTICIPANTS)
        throw new MessageError('participants')
      check(body.length === SIGNATURE_LEN * participants + NETTING_PROOF_LEN, 'final length')
      return {
        type: 'Final',
        signatures: Array.from({ length: participants }, (_, i) =>
          body.slice(i * SIGNATURE_LEN, (i + 1) * SIGNATURE_LEN),
        ),
        proof: body.slice(SIGNATURE_LEN * participants),
      }
    }
    case SessionType.Abort:
      check(body.length === 1 && body[0] >= 1 && body[0] <= 6, 'abort reason')
      return { type: 'Abort', reason: body[0] }
    case SessionType.Relay:
      check(body.length >= 3 && body[0] <= MAX_INDEX && body[1] <= MAX_INDEX && KINDS.includes(body[2]), 'relay header')
      return { type: 'Relay', from: body[0], to: body[1], kind: body[2] as MessageKind, payload: body.slice(3) }
    case SessionType.Simplify:
      return { type: 'Simplify', transfers: decodeSimplify(body) }
    case SessionType.SimplifyApprove: {
      check(body.length >= 1 && body[0] <= MAX_TABS && body.length === 1 + body[0], 'approve list')
      const approved = Array.from(body.slice(1))
      check(
        approved.every((i) => i < MAX_TABS),
        'approved index',
      )
      return { type: 'SimplifyApprove', approved }
    }
    default:
      throw new MessageError(`unknown type 0x${type.toString(16)}`)
  }
}
