import { ed25519 } from '@noble/curves/ed25519.js'
import { equalBytes } from '@noble/curves/utils.js'
import { concatBytes } from '@noble/hashes/utils.js'

import {
  type BondTicket,
  CHALLENGE,
  checkBytes,
  checkU32,
  checkU64,
  GRACE,
  Kind,
  type Owner,
  ProtocolError,
  ticketMessage,
  TICKET_TTL_MAX,
  U64_MAX,
  VERSION,
} from './codec'
import { covers, paymentLimit } from './slash'

/** A receiver stops believing a registry entry it read longer ago than this. */
export const MAX_REGISTRY_AGE = 7 * 24 * 60 * 60
/**
 * The longest note a receiver accepts by default, counted from the moment it accepts it: a note that
 * outlives the attester's exit delay can be settled after the stake has left.
 */
export const MAX_NOTE_LIFE = TICKET_TTL_MAX

/**
 * What a receiving wallet knows about one attester it trusts, as of its last read of the registry.
 * The twin of `ticket::Attester`.
 */
export type Attester = {
  id: number
  /** Signs revocations of this attester's keys. */
  authority: Uint8Array
  /** Tickets of this attester name this mint, and its stake is in it. */
  mint: Uint8Array
  stake: bigint
  /** The key that signs new tickets. */
  key: Uint8Array
  /** The key before the last rotation; all zeros if none. */
  prevKey: Uint8Array
  /** The previous key is still believed before this time; zero after a compromise. */
  prevTrustedUntil: number
  /** Keys the authority revoked, newest first. A revoked key is never believed again. */
  revoked: [Uint8Array, Uint8Array]
  /** When the registry entry was read. */
  syncedAt: number
  active: boolean
  /** What this wallet accepted on this attester's word and has not yet seen settled. */
  relied: bigint
}

/** Why a ticket was refused. Every refusal is `ProtocolError('Ticket')`; the wallet shows the reason. */
export type TicketReason =
  | 'Count'
  | 'Missing'
  | 'Mint'
  | 'LockTooShort'
  | 'Stale'
  | 'TooLong'
  | 'Bond'
  | 'Backing'
  | 'UnknownAttester'
  | 'Inactive'
  | 'RegistryStale'
  | 'AttesterMint'
  | 'AttesterStake'
  | 'AttesterCap'
  | 'UnknownKey'
  | 'Signature'

export class TicketRefusal extends ProtocolError {
  constructor(readonly reason: TicketReason) {
    super('Ticket')
  }
}

/** A lock whose bond backs a payment, with the bond its ticket shows and the attester that vouched. */
export type Liability = { device: Uint8Array; lockSeq: number; bond: bigint; attester: number }

/** What a liability needs from its ticket. */
export type Need = {
  mint: Uint8Array
  /** The amount the lock is liable for: the issue's, or the consumed output's. */
  amount: bigint
  /** The cumulative end of the issue, for the issuer's ticket. */
  backing?: bigint
  /** Expiry of the note or consumed output. */
  expiry: number
}

const ZERO_KEY = new Uint8Array(32)

/** Records `amount` accepted on the attester's word, never past what a `u64` holds. */
export const reliedOn = (attester: Attester, amount: bigint): Attester => {
  checkU64(amount)
  const sum = attester.relied + amount
  return { ...attester, relied: sum > U64_MAX ? U64_MAX : sum }
}

/** Records that `amount` of what was relied on has settled or expired. */
export const releaseOn = (attester: Attester, amount: bigint): Attester => {
  checkU64(amount)
  return { ...attester, relied: attester.relied > amount ? attester.relied - amount : 0n }
}

/** A canonical encoding of a point in the prime-order subgroup, other than the identity. */
export function primeOrder(bytes: Uint8Array): boolean {
  try {
    const point = ed25519.Point.fromBytes(bytes)
    return point.isTorsionFree() && !point.isSmallOrder()
  } catch {
    return false
  }
}

/**
 * Ed25519 as every verifier here checks it: the strict equation (`zip215: false`), with the key and
 * the nonce canonical, torsion-free and not small order, so Rust, this twin and the program's
 * precompile agree on every vector.
 */
export function verifyEd25519(key: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (key.length !== 32 || signature.length !== 64) return false
  if (!primeOrder(key) || !primeOrder(signature.subarray(0, 32))) return false
  try {
    return ed25519.verify(signature, message, key, { zip215: false })
  } catch {
    return false
  }
}

/** A revocation of one attester key, signed by the attester's authority. */
export type Revocation = { attester: number; key: Uint8Array; signature: Uint8Array }

export const REVOCATION_BODY_LEN = 36
export const REVOCATION_WIRE_LEN = 100

function revocationBody({ attester, key }: Revocation): Uint8Array {
  checkBytes(key, 32)
  const body = new Uint8Array(REVOCATION_BODY_LEN)
  body[0] = VERSION
  body[1] = Kind.Revocation
  new DataView(body.buffer).setUint16(2, attester, true)
  body.set(key, 4)
  return body
}

export function encodeRevocation(revocation: Revocation): Uint8Array {
  checkBytes(revocation.signature, 64)
  return concatBytes(revocationBody(revocation), revocation.signature)
}

export function decodeRevocation(wire: Uint8Array): Revocation {
  if (wire.length !== REVOCATION_WIRE_LEN) throw new ProtocolError('Length')
  if (wire[0] !== VERSION) throw new ProtocolError('Version')
  if (wire[1] !== Kind.Revocation) throw new ProtocolError('Kind')
  return {
    attester: new DataView(wire.buffer, wire.byteOffset).getUint16(2, true),
    key: wire.slice(4, REVOCATION_BODY_LEN),
    signature: wire.slice(REVOCATION_BODY_LEN),
  }
}

/** The bytes the authority signs with Ed25519: the revoke-purpose domain, then the body. */
export const revocationMessage = (revokeDomain: Uint8Array, revocation: Revocation) =>
  concatBytes(revokeDomain, revocationBody(revocation))

/** Applies a revocation signed by the attester's authority. Idempotent. */
export function applyRevocation(attester: Attester, revokeDomain: Uint8Array, revocation: Revocation): Attester {
  if (revocation.attester !== attester.id) throw new ProtocolError('Signer')
  if (!verifyEd25519(attester.authority, revocationMessage(revokeDomain, revocation), revocation.signature)) {
    throw new ProtocolError('Signature')
  }
  if (attester.revoked.some((key) => equalBytes(key, revocation.key))) return attester
  return { ...attester, revoked: [revocation.key, attester.revoked[0]] }
}

const believed = (attester: Attester, key: Uint8Array) =>
  !equalBytes(key, ZERO_KEY) && !attester.revoked.some((revoked) => equalBytes(revoked, key))

/** The keys whose tickets are believed at `now`: the current one, and the previous one during its overlap. */
export const signingKeys = (attester: Attester, now: number): [Uint8Array | undefined, Uint8Array | undefined] => [
  believed(attester, attester.key) ? attester.key : undefined,
  now < attester.prevTrustedUntil && believed(attester, attester.prevKey) ? attester.prevKey : undefined,
]

/** Whether the registry entry is recent enough to be believed. */
export const attesterFresh = (attester: Attester, now: number) => now - attester.syncedAt <= MAX_REGISTRY_AGE

/**
 * A payment carries at most one ticket per message and at most one per lock, so a sender cannot make
 * the receiver check more signatures than the chain needs.
 */
export function checkCount(spends: number, tickets: BondTicket[]) {
  const duplicate = tickets.some((a, i) =>
    tickets.slice(i + 1).some((b) => equalBytes(a.device, b.device) && a.lockSeq === b.lockSeq),
  )
  if (tickets.length > spends + 1 || duplicate) throw new TicketRefusal('Count')
}

/**
 * Decides whether the ticket for `(device, lockSeq)` covers `need` at `now`, in the order that puts
 * the signature last. The twin of `ticket::accept`: nothing else compares a bond, a stake, a
 * lifetime or a signature for a ticket.
 */
export function accept(
  now: number,
  ticketDomain: Uint8Array,
  attesters: Attester[],
  tickets: BondTicket[],
  device: Owner,
  lockSeq: number,
  need: Need,
): Liability {
  checkU32(now)
  const ticket = tickets.find(
    (t) => device.type === 'device' && equalBytes(t.device, device.key) && t.lockSeq === lockSeq,
  )
  if (!ticket) throw new TicketRefusal('Missing')
  if (!equalBytes(ticket.mint, need.mint)) throw new TicketRefusal('Mint')
  if (ticket.lockUntil <= need.expiry + GRACE + CHALLENGE) throw new TicketRefusal('LockTooShort')
  if (now > ticket.validUntil) throw new TicketRefusal('Stale')
  if (ticket.validUntil - now > TICKET_TTL_MAX) throw new TicketRefusal('TooLong')
  if (!covers(ticket.bond, need.amount)) throw new TicketRefusal('Bond')
  if (need.backing !== undefined && ticket.backing < need.backing) throw new TicketRefusal('Backing')
  const attester = attesters.find((a) => a.id === ticket.attester)
  if (!attester) throw new TicketRefusal('UnknownAttester')
  if (!attester.active) throw new TicketRefusal('Inactive')
  if (!attesterFresh(attester, now)) throw new TicketRefusal('RegistryStale')
  if (!equalBytes(attester.mint, ticket.mint)) throw new TicketRefusal('AttesterMint')
  if (!covers(attester.stake, need.amount)) throw new TicketRefusal('AttesterStake')
  if (attester.relied + need.amount > paymentLimit(attester.stake)) throw new TicketRefusal('AttesterCap')
  const keys = signingKeys(attester, now).filter((key): key is Uint8Array => key !== undefined)
  if (keys.length === 0) throw new TicketRefusal('UnknownKey')
  const message = ticketMessage(ticketDomain, ticket)
  if (!keys.some((key) => verifyEd25519(key, message, ticket.signature))) throw new TicketRefusal('Signature')
  return { device: ticket.device, lockSeq, bond: ticket.bond, attester: ticket.attester }
}
