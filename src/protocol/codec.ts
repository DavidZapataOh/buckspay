import {
  fixCodecSize,
  getBytesCodec,
  getStructCodec,
  getU16Codec,
  getU32Codec,
  getU64Codec,
  getU8Codec,
  transformCodec,
} from '@solana/kit'
import { equalBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'

export type ErrorCode =
  | 'Length'
  | 'Version'
  | 'Kind'
  | 'Owner'
  | 'Flags'
  | 'ScopeKind'
  | 'Scope'
  | 'Amount'
  | 'Depth'
  | 'Attenuation'
  | 'Linkage'
  | 'Signer'
  | 'Signature'
  | 'Expired'
  | 'Change'
  | 'Lock'
  | 'Ticket'
  | 'Window'
  | 'Payee'
  | 'ExpiryStep'
  | 'Unrecordable'

export class ProtocolError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code)
    this.name = 'ProtocolError'
  }
}

export const VERSION = 1
export const MAX_DEPTH = 16
export const NO_LOCK = 0xffffffff
export const GRACE = 7 * 24 * 60 * 60
export const CHALLENGE = 7 * 24 * 60 * 60
/** A receiver refuses a ticket valid for longer than this from now, whatever its attester signed. */
export const TICKET_TTL_MAX = 3 * 24 * 60 * 60
/** A payment to a device expires at least this long before the output it spends. */
export const EXPIRY_STEP = 60 * 60
export const Kind = {
  Issue: 0x01,
  Spend1: 0x02,
  Spend2: 0x03,
  BondTicket: 0x10,
  Revocation: 0x11,
  SpendConflict: 0x20,
  IssueConflict: 0x21,
  DeviceBinding: 0x50,
  Rotation: 0x51,
  Reclaim: 0x60,
} as const
export const Flags = { Delegated: 1, AuthorityOnly: 2, Sticky: 2, Known: 3 } as const
export const ScopeKind = { Any: 0, Merchant: 1, Category: 2, Authority: 3 } as const

export const U64_MAX = 2n ** 64n - 1n

const checkUint = (value: number, max: number) => {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new ProtocolError('Length')
}

/**
 * Integer and byte width checks for values built in memory (a decoder never produces others),
 * reported as `Length`. Rust's types make them implicit.
 */
export const checkU8 = (value: number) => checkUint(value, 0xff)
export const checkU32 = (value: number) => checkUint(value, 0xffffffff)
export function checkU64(value: bigint) {
  if (value < 0n || value > U64_MAX) throw new ProtocolError('Length')
}
export function checkBytes(value: Uint8Array, length: number) {
  if (value.length !== length) throw new ProtocolError('Length')
}

export const ISSUE_BODY_LEN = 163
export const ISSUE_WIRE_LEN = 227
export const SPEND1_BODY_LEN = 82
export const SPEND2_BODY_LEN = 123
export const SPEND1_WIRE_LEN = 178
export const SPEND2_WIRE_LEN = 219
export const BOND_TICKET_BODY_LEN = 97
export const BOND_TICKET_WIRE_LEN = 161
export const SPEND_CONFLICT_WIRE_LEN = 227
export const ISSUE_CONFLICT_WIRE_LEN = 235

export type Owner = { type: 'device'; key: Uint8Array } | { type: 'account'; address: Uint8Array }
export type Caveats = { expiry: number; hopsLeft: number; flags: number; scopeKind: number; scope: Uint8Array }
export type Signed<T> = { message: T; signature: Uint8Array }
export type Issue = {
  issuer: Uint8Array
  mint: Uint8Array
  lockSeq: number
  cumEnd: bigint
  salt: Uint8Array
  owner: Owner
  amount: bigint
  caveats: Caveats
}
export type Outputs =
  | { type: 'one'; owner: Owner; caveats: Caveats }
  | { type: 'two'; owner0: Owner; amount0: bigint; caveats0: Caveats; owner1: Owner }
export type Spend = { input: Uint8Array; lockSeq: number; salt: Uint8Array; outputs: Outputs }
export type BondTicket = {
  device: Uint8Array
  mint: Uint8Array
  lockSeq: number
  bond: bigint
  backing: bigint
  lockUntil: number
  /** The last second at which a receiver accepts a payment on the strength of this ticket. */
  validUntil: number
  attester: number
  signature: Uint8Array
}
export type SpendConflict = {
  slot: Uint8Array
  contentA: Uint8Array
  signatureA: Uint8Array
  contentB: Uint8Array
  signatureB: Uint8Array
  recovery: number
}
export type IssueClaim = { lockSeq: number; start: bigint; end: bigint; content: Uint8Array; signature: Uint8Array }
export type IssueConflict = { a: IssueClaim; b: IssueClaim; recovery: number }

const bytes = (size: number) =>
  transformCodec(
    fixCodecSize(getBytesCodec(), size),
    (value: Uint8Array) => value,
    (value) => Uint8Array.from(value),
  )

const caveatsCodec = getStructCodec([
  ['expiry', getU32Codec()],
  ['hopsLeft', getU8Codec()],
  ['flags', getU8Codec()],
  ['scopeKind', getU8Codec()],
  ['scope', bytes(20)],
])

const issueBodyCodec = getStructCodec([
  ['version', getU8Codec()],
  ['kind', getU8Codec()],
  ['issuer', bytes(33)],
  ['mint', bytes(32)],
  ['lockSeq', getU32Codec()],
  ['cumEnd', getU64Codec()],
  ['salt', bytes(16)],
  ['owner', bytes(33)],
  ['amount', getU64Codec()],
  ['caveats', caveatsCodec],
])

const spend1BodyCodec = getStructCodec([
  ['version', getU8Codec()],
  ['kind', getU8Codec()],
  ['lockSeq', getU32Codec()],
  ['salt', bytes(16)],
  ['owner', bytes(33)],
  ['caveats', caveatsCodec],
])

const spend2BodyCodec = getStructCodec([
  ['version', getU8Codec()],
  ['kind', getU8Codec()],
  ['lockSeq', getU32Codec()],
  ['salt', bytes(16)],
  ['owner0', bytes(33)],
  ['amount0', getU64Codec()],
  ['caveats0', caveatsCodec],
  ['owner1', bytes(33)],
])

const bondTicketBodyCodec = getStructCodec([
  ['version', getU8Codec()],
  ['kind', getU8Codec()],
  ['device', bytes(33)],
  ['mint', bytes(32)],
  ['lockSeq', getU32Codec()],
  ['bond', getU64Codec()],
  ['backing', getU64Codec()],
  ['lockUntil', getU32Codec()],
  ['validUntil', getU32Codec()],
  ['attester', getU16Codec()],
])

const spendConflictCodec = getStructCodec([
  ['version', getU8Codec()],
  ['kind', getU8Codec()],
  ['slot', bytes(32)],
  ['contentA', bytes(32)],
  ['signatureA', bytes(64)],
  ['contentB', bytes(32)],
  ['signatureB', bytes(64)],
  ['recovery', getU8Codec()],
])

const issueClaimCodec = getStructCodec([
  ['lockSeq', getU32Codec()],
  ['start', getU64Codec()],
  ['end', getU64Codec()],
  ['content', bytes(32)],
  ['signature', bytes(64)],
])

const issueConflictCodec = getStructCodec([
  ['version', getU8Codec()],
  ['kind', getU8Codec()],
  ['a', issueClaimCodec],
  ['b', issueClaimCodec],
  ['recovery', getU8Codec()],
])

function checkVersion(bytes: Uint8Array) {
  if (bytes[0] !== VERSION) throw new ProtocolError('Version')
}

function checkHeader(bytes: Uint8Array, length: number, kind: number) {
  if (bytes.length !== length) throw new ProtocolError('Length')
  checkVersion(bytes)
  if (bytes[1] !== kind) throw new ProtocolError('Kind')
}

export function decodeOwner(raw: Uint8Array): Owner {
  if (raw.length !== 33) throw new ProtocolError('Length')
  if (raw[0] === 0x02 || raw[0] === 0x03) return { type: 'device', key: raw }
  if (raw[0] === 0x00) return { type: 'account', address: raw.slice(1) }
  throw new ProtocolError('Owner')
}

export function checkOwnerBytes(owner: Owner) {
  if (owner.type === 'device') checkBytes(owner.key, 33)
  else checkBytes(owner.address, 32)
}

export function encodeOwner(owner: Owner): Uint8Array {
  checkOwnerBytes(owner)
  if (owner.type === 'device') return owner.key
  const out = new Uint8Array(33)
  out.set(owner.address, 1)
  return out
}

function checkDevice(raw: Uint8Array) {
  if (decodeOwner(raw).type !== 'device') throw new ProtocolError('Owner')
}

const SCOPE_TAG = utf8ToBytes('BPS1')

export const scopeHash = (owner: Owner) => sha256(concatBytes(SCOPE_TAG, encodeOwner(owner))).slice(0, 20)

export function checkCaveats(caveats: Caveats): Caveats {
  checkU32(caveats.expiry)
  checkU8(caveats.hopsLeft)
  checkU8(caveats.flags)
  checkU8(caveats.scopeKind)
  checkBytes(caveats.scope, 20)
  if (caveats.scopeKind > ScopeKind.Authority) throw new ProtocolError('ScopeKind')
  if (caveats.flags & ~Flags.Known) throw new ProtocolError('Flags')
  const padding =
    caveats.scopeKind === ScopeKind.Any
      ? caveats.scope
      : caveats.scopeKind === ScopeKind.Category
        ? caveats.scope.subarray(2)
        : new Uint8Array(0)
  const authorityOnly = (caveats.flags & Flags.AuthorityOnly) !== 0
  if (padding.some((byte) => byte !== 0) || (authorityOnly && caveats.scopeKind !== ScopeKind.Authority)) {
    throw new ProtocolError('Scope')
  }
  return caveats
}

export const decodeCaveats = (raw: Uint8Array) => checkCaveats(caveatsCodec.decode(raw))
export const encodeCaveats = (caveats: Caveats) => Uint8Array.from(caveatsCodec.encode(caveats))

export function permits(parent: Caveats, child: Caveats): boolean {
  return (
    parent.hopsLeft >= 1 &&
    child.hopsLeft < parent.hopsLeft &&
    child.expiry <= parent.expiry &&
    (child.flags & Flags.Sticky) === (parent.flags & Flags.Sticky) &&
    (parent.scopeKind === ScopeKind.Any ||
      (child.scopeKind === parent.scopeKind && equalBytes(child.scope, parent.scope)))
  )
}

export function admits(caveats: Caveats, payee: Owner): boolean {
  if (caveats.scopeKind === ScopeKind.Merchant || caveats.scopeKind === ScopeKind.Authority) {
    return equalBytes(scopeHash(payee), caveats.scope)
  }
  return true
}

/**
 * The caveats a spend by `holder` must obey. A merchant scope that names `holder` has reached its
 * party, so it no longer binds that spend. An authority scope is never lifted: the authority is a
 * terminal account, and its outputs are never spent.
 */
export function forHolder(caveats: Caveats, holder: Owner): Caveats {
  if (caveats.scopeKind !== ScopeKind.Merchant || !equalBytes(scopeHash(holder), caveats.scope)) return caveats
  return { ...caveats, scopeKind: ScopeKind.Any, scope: new Uint8Array(20) }
}

/**
 * An authority is a terminal account, so an output whose authority scope names its own owner must
 * be owned by an account (`Scope`).
 */
export function checkHolder(caveats: Caveats, owner: Owner) {
  const deviceAuthority =
    caveats.scopeKind === ScopeKind.Authority && owner.type === 'device' && equalBytes(scopeHash(owner), caveats.scope)
  if (deviceAuthority) throw new ProtocolError('Scope')
}

/** Change keeps the input's caveats with one hop less, and must itself stay spendable. */
export function change(parent: Caveats): Caveats {
  if (parent.hopsLeft < 2) throw new ProtocolError('Depth')
  return { ...parent, hopsLeft: parent.hopsLeft - 1 }
}

export function interval(issue: Issue): [bigint, bigint] {
  if (issue.cumEnd < issue.amount) throw new ProtocolError('Amount')
  return [issue.cumEnd - issue.amount, issue.cumEnd]
}

export function checkIssue(issue: Issue): Issue {
  checkU32(issue.lockSeq)
  checkU64(issue.cumEnd)
  checkU64(issue.amount)
  checkDevice(issue.issuer)
  checkBytes(issue.mint, 32)
  checkBytes(issue.salt, 16)
  checkOwnerBytes(issue.owner)
  if (issue.amount === 0n) throw new ProtocolError('Amount')
  if (issue.lockSeq === NO_LOCK) throw new ProtocolError('Lock')
  checkCaveats(issue.caveats)
  checkHolder(issue.caveats, issue.owner)
  if (issue.caveats.hopsLeft > MAX_DEPTH) throw new ProtocolError('Depth')
  interval(issue)
  return issue
}

export const encodeIssueBody = (issue: Issue) =>
  Uint8Array.from(
    issueBodyCodec.encode({ ...issue, version: VERSION, kind: Kind.Issue, owner: encodeOwner(issue.owner) }),
  )

export const encodeIssue = ({ message, signature }: Signed<Issue>) => concatBytes(encodeIssueBody(message), signature)

export function decodeIssue(wire: Uint8Array): Signed<Issue> {
  checkHeader(wire, ISSUE_WIRE_LEN, Kind.Issue)
  const raw = issueBodyCodec.decode(wire)
  const issue: Issue = {
    issuer: raw.issuer,
    mint: raw.mint,
    lockSeq: raw.lockSeq,
    cumEnd: raw.cumEnd,
    salt: raw.salt,
    owner: decodeOwner(raw.owner),
    amount: raw.amount,
    caveats: checkCaveats(raw.caveats),
  }
  return { message: checkIssue(issue), signature: wire.slice(ISSUE_BODY_LEN) }
}

export function checkSpend(spend: Spend): Spend {
  checkBytes(spend.input, 32)
  checkU32(spend.lockSeq)
  checkBytes(spend.salt, 16)
  const { outputs } = spend
  if (outputs.type === 'two') {
    checkOwnerBytes(outputs.owner1)
    checkU64(outputs.amount0)
    if (outputs.amount0 === 0n) throw new ProtocolError('Amount')
  }
  const [owner, caveats] =
    outputs.type === 'one' ? [outputs.owner, outputs.caveats] : [outputs.owner0, outputs.caveats0]
  checkOwnerBytes(owner)
  checkCaveats(caveats)
  checkHolder(caveats, owner)
  return spend
}

export function encodeSpendBody({ lockSeq, salt, outputs }: Spend): Uint8Array {
  if (outputs.type === 'one') {
    return Uint8Array.from(
      spend1BodyCodec.encode({
        version: VERSION,
        kind: Kind.Spend1,
        lockSeq,
        salt,
        owner: encodeOwner(outputs.owner),
        caveats: outputs.caveats,
      }),
    )
  }
  return Uint8Array.from(
    spend2BodyCodec.encode({
      version: VERSION,
      kind: Kind.Spend2,
      lockSeq,
      salt,
      owner0: encodeOwner(outputs.owner0),
      amount0: outputs.amount0,
      caveats0: outputs.caveats0,
      owner1: encodeOwner(outputs.owner1),
    }),
  )
}

export const encodeSpend = ({ message, signature }: Signed<Spend>) =>
  concatBytes(message.input, encodeSpendBody(message), signature)

function decodeSpendBody(input: Uint8Array, body: Uint8Array): Spend {
  const kind = body[1]
  if (kind === Kind.Spend1 && body.length === SPEND1_BODY_LEN) {
    checkVersion(body)
    const raw = spend1BodyCodec.decode(body)
    const outputs: Outputs = { type: 'one', owner: decodeOwner(raw.owner), caveats: checkCaveats(raw.caveats) }
    return checkSpend({ input, lockSeq: raw.lockSeq, salt: raw.salt, outputs })
  }
  if (kind === Kind.Spend2 && body.length === SPEND2_BODY_LEN) {
    checkVersion(body)
    const raw = spend2BodyCodec.decode(body)
    const outputs: Outputs = {
      type: 'two',
      owner0: decodeOwner(raw.owner0),
      amount0: raw.amount0,
      caveats0: checkCaveats(raw.caveats0),
      owner1: decodeOwner(raw.owner1),
    }
    return checkSpend({ input, lockSeq: raw.lockSeq, salt: raw.salt, outputs })
  }
  if (kind === Kind.Spend1 || kind === Kind.Spend2) throw new ProtocolError('Length')
  checkVersion(body)
  throw new ProtocolError('Kind')
}

export function decodeSpend(wire: Uint8Array): Signed<Spend> {
  if (wire.length !== SPEND1_WIRE_LEN && wire.length !== SPEND2_WIRE_LEN) throw new ProtocolError('Length')
  const bodyEnd = wire.length - 64
  return {
    message: decodeSpendBody(wire.slice(0, 32), wire.subarray(32, bodyEnd)),
    signature: wire.slice(bodyEnd),
  }
}

const encodeBondTicketBody = (ticket: BondTicket) =>
  Uint8Array.from(bondTicketBodyCodec.encode({ ...ticket, version: VERSION, kind: Kind.BondTicket }))

export const encodeBondTicket = (ticket: BondTicket) => concatBytes(encodeBondTicketBody(ticket), ticket.signature)

/** The bytes the attester signs with Ed25519: the ticket-purpose domain, then the body. */
export const ticketMessage = (ticketDomain: Uint8Array, ticket: BondTicket) =>
  concatBytes(ticketDomain, encodeBondTicketBody(ticket))

export function decodeBondTicket(wire: Uint8Array): BondTicket {
  checkHeader(wire, BOND_TICKET_WIRE_LEN, Kind.BondTicket)
  const { device, mint, lockSeq, bond, backing, lockUntil, validUntil, attester } = bondTicketBodyCodec.decode(wire)
  checkDevice(device)
  return {
    device,
    mint,
    lockSeq,
    bond,
    backing,
    lockUntil,
    validUntil,
    attester,
    signature: wire.slice(BOND_TICKET_BODY_LEN),
  }
}

function checkRecovery(recovery: number) {
  if (recovery > 0x0f) throw new ProtocolError('Signature')
  return recovery
}

export const encodeSpendConflict = (conflict: SpendConflict) =>
  Uint8Array.from(spendConflictCodec.encode({ ...conflict, version: VERSION, kind: Kind.SpendConflict }))

export function decodeSpendConflict(wire: Uint8Array): SpendConflict {
  checkHeader(wire, SPEND_CONFLICT_WIRE_LEN, Kind.SpendConflict)
  const { slot, contentA, signatureA, contentB, signatureB, recovery } = spendConflictCodec.decode(wire)
  return { slot, contentA, signatureA, contentB, signatureB, recovery: checkRecovery(recovery) }
}

export const encodeIssueConflict = (conflict: IssueConflict) =>
  Uint8Array.from(issueConflictCodec.encode({ ...conflict, version: VERSION, kind: Kind.IssueConflict }))

export function decodeIssueConflict(wire: Uint8Array): IssueConflict {
  checkHeader(wire, ISSUE_CONFLICT_WIRE_LEN, Kind.IssueConflict)
  const { a, b, recovery } = issueConflictCodec.decode(wire)
  return { a, b, recovery: checkRecovery(recovery) }
}
