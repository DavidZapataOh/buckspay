import { equalBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { checkBytes, checkU32, checkU64, checkU8, Kind, ProtocolError, VERSION } from './codec'
import { content, envelope } from './hash'
import { derive, NETTING_SEED } from './record'

export const MAX_PARTICIPANTS = 8
export const STATEMENT_BASE_LEN = 111
export const NETTING_PUBLIC = 4

const SESSION_FIELD_TAG = utf8ToBytes('BUCKSPAY:v1:netting-session')
/** The BN254 scalar field order r, big-endian. */
const BN254_R_BYTES = hexToBytes('30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001')

export type NettingStatement = {
  session: Uint8Array
  mint: Uint8Array
  participants: number
  total: bigint
  expires: number
  /** Big-endian, below r. */
  root: Uint8Array
  /** One Ed25519 key per participant. */
  ephemeral: Uint8Array[]
}

const beCompare = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/** The rules of the Rust `NettingStatement::check`, in the same order. */
function checkStatement(s: NettingStatement): void {
  checkBytes(s.session, 32)
  checkBytes(s.mint, 32)
  checkBytes(s.root, 32)
  checkU8(s.participants)
  checkU64(s.total)
  checkU32(s.expires)
  s.ephemeral.forEach((key) => checkBytes(key, 32))
  if (s.participants < 2 || s.participants > MAX_PARTICIPANTS || s.ephemeral.length !== s.participants)
    throw new ProtocolError('Length')
  s.ephemeral.forEach((key, i) => {
    if (s.ephemeral.slice(0, i).some((other) => equalBytes(other, key))) throw new ProtocolError('Signer')
  })
  if (beCompare(s.root, BN254_R_BYTES) >= 0) throw new ProtocolError('Amount')
}

export function encodeStatement(s: NettingStatement): Uint8Array {
  checkStatement(s)
  const out = new Uint8Array(STATEMENT_BASE_LEN + 32 * s.participants)
  const view = new DataView(out.buffer)
  out[0] = VERSION
  out[1] = Kind.Netting
  out.set(s.session, 2)
  out.set(s.mint, 34)
  out[66] = s.participants
  view.setBigUint64(67, s.total, true)
  view.setUint32(75, s.expires, true)
  out.set(s.root, 79)
  s.ephemeral.forEach((key, i) => out.set(key, STATEMENT_BASE_LEN + 32 * i))
  return out
}

export function decodeStatement(body: Uint8Array): NettingStatement {
  if (body.length < 67) throw new ProtocolError('Length')
  if (body[0] !== VERSION) throw new ProtocolError('Version')
  if (body[1] !== Kind.Netting) throw new ProtocolError('Kind')
  const n = body[66]
  if (n < 2 || n > MAX_PARTICIPANTS || body.length !== STATEMENT_BASE_LEN + 32 * n) throw new ProtocolError('Length')
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  const statement: NettingStatement = {
    session: body.slice(2, 34),
    mint: body.slice(34, 66),
    participants: n,
    total: view.getBigUint64(67, true),
    expires: view.getUint32(75, true),
    root: body.slice(79, 111),
    ephemeral: Array.from({ length: n }, (_, i) =>
      body.slice(STATEMENT_BASE_LEN + 32 * i, STATEMENT_BASE_LEN + 32 * (i + 1)),
    ),
  }
  checkStatement(statement)
  return statement
}

export const statementContent = (s: NettingStatement): Uint8Array => content(encodeStatement(s))

/** `nettingDomain ‖ session ‖ content`: the message every participant signs. */
export const statementEnvelope = (s: NettingStatement, nettingDomain: Uint8Array): Uint8Array =>
  envelope(nettingDomain, s.session, statementContent(s))

/** What a proof binds to: the session, mint, expiry and every key, cut to a field element (top three bits cleared). */
export function sessionField(s: NettingStatement): Uint8Array {
  checkStatement(s)
  const expires = new Uint8Array(4)
  new DataView(expires.buffer).setUint32(0, s.expires, true)
  const field = sha256(
    concatBytes(SESSION_FIELD_TAG, s.session, s.mint, expires, Uint8Array.of(s.participants), ...s.ephemeral),
  )
  field[0] &= 0x1f
  return field
}

const be32 = (value: bigint) => {
  const out = new Uint8Array(32)
  new DataView(out.buffer).setBigUint64(24, value, false)
  return out
}

/** `[session field, n, total, root]`, each 32 bytes big-endian, as the circuit reads them. */
export const publicInputs = (s: NettingStatement): Uint8Array[] => [
  sessionField(s),
  be32(BigInt(s.participants)),
  be32(s.total),
  s.root,
]

/** Where a statement is recorded, or `null` when its address is on the curve. */
export const nettingAddress = (programId: Uint8Array, statementContentHash: Uint8Array): Uint8Array | null =>
  derive(NETTING_SEED, programId, statementContentHash) ?? null
