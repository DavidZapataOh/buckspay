import { sanitizeMemo } from '../../payment/messages'

const VERSION = 1
const ID_BYTES = 16
const AUTHORITY_BYTES = 32
const SECRET_BYTES = 32
const ISSUER_BYTES = 33
const MAX_NAME_BYTES = 48
const MAX_ISSUERS = 8
const INVITE_FIXED = 1 + ID_BYTES + AUTHORITY_BYTES + 4 + 1

export type EventInvite = { eventId: Uint8Array; authority: Uint8Array; name: string; endsAt: number }
export type PointPairing = EventInvite & { eventSecret: Uint8Array; issuers: Uint8Array[] }

function checkLength(bytes: Uint8Array, size: number, what: string) {
  if (bytes.length !== size) throw new RangeError(`${what} must be ${size} bytes`)
}

/** The invite an attendee scans: the event, the account that redeems its credit, a name and the end. */
export function encodeInvite(invite: EventInvite): Uint8Array {
  checkLength(invite.eventId, ID_BYTES, 'eventId')
  checkLength(invite.authority, AUTHORITY_BYTES, 'authority')
  if (!Number.isInteger(invite.endsAt) || invite.endsAt < 0 || invite.endsAt > 0xffffffff) {
    throw new RangeError('endsAt must be a u32')
  }
  const name = new TextEncoder().encode(sanitizeMemo(invite.name))
  if (name.length > MAX_NAME_BYTES) throw new RangeError(`the name is longer than ${MAX_NAME_BYTES} bytes`)
  const out = new Uint8Array(INVITE_FIXED + name.length)
  out[0] = VERSION
  out.set(invite.eventId, 1)
  out.set(invite.authority, 1 + ID_BYTES)
  new DataView(out.buffer).setUint32(1 + ID_BYTES + AUTHORITY_BYTES, invite.endsAt)
  out[INVITE_FIXED - 1] = name.length
  out.set(name, INVITE_FIXED)
  return out
}

function readInvite(bytes: Uint8Array): { invite: EventInvite; end: number } {
  if (bytes.length < INVITE_FIXED || bytes[0] !== VERSION) throw new RangeError('not an event invite')
  const nameLength = bytes[INVITE_FIXED - 1]
  const end = INVITE_FIXED + nameLength
  if (nameLength > MAX_NAME_BYTES || bytes.length < end) throw new RangeError('the event name does not fit')
  const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(INVITE_FIXED, end))
  if (sanitizeMemo(name) !== name) throw new RangeError('the event name has hidden or repeated spaces')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    invite: {
      eventId: bytes.slice(1, 1 + ID_BYTES),
      authority: bytes.slice(1 + ID_BYTES, 1 + ID_BYTES + AUTHORITY_BYTES),
      name,
      endsAt: view.getUint32(1 + ID_BYTES + AUTHORITY_BYTES),
    },
    end,
  }
}

export function decodeInvite(bytes: Uint8Array): EventInvite {
  const { invite, end } = readInvite(bytes)
  if (end !== bytes.length) throw new RangeError('trailing bytes after the invite')
  return invite
}

/** The pairing of a point: the invite plus the secret that authenticates the points and the issuers it accepts. */
export function encodePairing(pairing: PointPairing): Uint8Array {
  checkLength(pairing.eventSecret, SECRET_BYTES, 'eventSecret')
  if (pairing.issuers.length < 1 || pairing.issuers.length > MAX_ISSUERS) {
    throw new RangeError(`a pairing lists 1 to ${MAX_ISSUERS} issuers`)
  }
  for (const issuer of pairing.issuers) checkLength(issuer, ISSUER_BYTES, 'issuer')
  const invite = encodeInvite(pairing)
  const out = new Uint8Array(invite.length + SECRET_BYTES + 1 + ISSUER_BYTES * pairing.issuers.length)
  out.set(invite)
  out.set(pairing.eventSecret, invite.length)
  out[invite.length + SECRET_BYTES] = pairing.issuers.length
  pairing.issuers.forEach((issuer, i) => out.set(issuer, invite.length + SECRET_BYTES + 1 + i * ISSUER_BYTES))
  return out
}

export function decodePairing(bytes: Uint8Array): PointPairing {
  const { invite, end } = readInvite(bytes)
  const count = bytes[end + SECRET_BYTES]
  if (bytes.length < end + SECRET_BYTES + 1 || count < 1 || count > MAX_ISSUERS) {
    throw new RangeError('not a point pairing')
  }
  if (bytes.length !== end + SECRET_BYTES + 1 + ISSUER_BYTES * count)
    throw new RangeError('the pairing has the wrong length')
  const first = end + SECRET_BYTES + 1
  const issuers = Array.from({ length: count }, (_, i) =>
    bytes.slice(first + i * ISSUER_BYTES, first + (i + 1) * ISSUER_BYTES),
  )
  return { ...invite, eventSecret: bytes.slice(end, end + SECRET_BYTES), issuers }
}
