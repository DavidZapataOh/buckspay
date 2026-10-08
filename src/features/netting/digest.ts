import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { encodeStatement, type NettingStatement, sessionField } from '../../protocol/netting'
import { BN254_R, fromCanonical, poseidon2, toBytes32 } from '../rewards/secrets-poseidon'

export const SLOTS = 28
export const SLOT_WIRE_LEN = 86
const PARTICIPANTS = 8
const U64 = 1n << 64n

const TAB_TAG = utf8ToBytes('BUCKSPAY:v1:netting-tab')
const SALT_TAG = utf8ToBytes('BUCKSPAY:v1:netting-salt')

/** One tab inside a netting: the debt it carried at `seq`, how much of it the netting cancels, and the salt of its leaf. */
export type Slot = { tab: Uint8Array; seq: number; dir: 0 | 1; debt: bigint; cancel: bigint; salt: bigint }

/** What a member shows to prove a tab at a sequence number is under the statement's root. */
export type LeafOpening = {
  session: Uint8Array
  p: number
  /** The 7 slots of participant `p`, in increasing order of the other participant. */
  slots: (Slot | null)[]
  /** The 8 digests, one per participant. */
  digests: bigint[]
}

const fieldOf = (hash: Uint8Array) => {
  const out = hash.slice()
  out[0] &= 0x1f
  return BigInt(`0x${bytesToHex(out)}`)
}

const checkParticipant = (p: number) => {
  if (!Number.isInteger(p) || p < 0 || p >= PARTICIPANTS) throw new RangeError('participant index')
}

/** The index of the pair `(i, j)`, `i < j`, among the 28 slots in lexicographic order. */
export function slotIndex(i: number, j: number): number {
  checkParticipant(i)
  checkParticipant(j)
  if (i >= j) throw new RangeError('slot pair')
  return (i * (15 - i)) / 2 + (j - i - 1)
}

export const tabField = (tab: Uint8Array): bigint => {
  if (tab.length !== 32) throw new RangeError('tab id')
  return fieldOf(sha256(concatBytes(TAB_TAG, tab)))
}

/** Both endpoints of a tab derive the same salt from the tab secret and the session. */
export function saltFor(tabSecret: Uint8Array, session: Uint8Array): bigint {
  if (tabSecret.length !== 32 || session.length !== 32) throw new RangeError('salt input')
  return fieldOf(sha256(concatBytes(SALT_TAG, tabSecret, session)))
}

function checkSlot(slot: Slot) {
  if (slot.tab.length !== 32) throw new RangeError('tab id')
  if (!Number.isInteger(slot.seq) || slot.seq < 0 || slot.seq > 0xffffffff) throw new RangeError('seq')
  if (slot.dir !== 0 && slot.dir !== 1) throw new RangeError('dir')
  if (slot.debt < 0n || slot.debt >= U64) throw new RangeError('debt')
  if (slot.cancel < 0n || slot.cancel >= U64) throw new RangeError('cancel')
  if (slot.salt < 0n || slot.salt >= BN254_R) throw new RangeError('salt')
}

/** The leaf of a slot; an absent tab is the constant leaf of five zeros. */
export function leaf(slot: Slot | null): bigint {
  if (slot === null) return poseidon2(poseidon2(poseidon2(poseidon2(0n, 0n), 0n), 0n), 0n)
  checkSlot(slot)
  const seqDir = BigInt(slot.seq) * 2n + BigInt(slot.dir)
  return poseidon2(poseidon2(poseidon2(poseidon2(slot.salt, tabField(slot.tab)), seqDir), slot.debt), slot.cancel)
}

function checkSlots(slots: readonly (Slot | null)[]) {
  if (slots.length !== SLOTS) throw new RangeError('a netting has 28 slots')
  for (const slot of slots) if (slot) checkSlot(slot)
}

/** The digest of participant `p`: the session, `p` and its 7 leaves in increasing order of the other participant. */
export function digest(session: Uint8Array, p: number, slots: readonly (Slot | null)[]): bigint {
  checkParticipant(p)
  checkSlots(slots)
  let state = poseidon2(fromCanonical(session, 'session field'), BigInt(p))
  for (let q = 0; q < PARTICIPANTS; q++) {
    if (q !== p) state = poseidon2(state, leaf(slots[slotIndex(Math.min(p, q), Math.max(p, q))]))
  }
  return state
}

/** The root over the 8 digests in participant order. */
export function rootOf(digests: readonly bigint[]): bigint {
  if (digests.length !== PARTICIPANTS) throw new RangeError('a netting has 8 digests')
  return digests.slice(1).reduce((state, d) => poseidon2(state, d), digests[0])
}

const slotWire = (slot: Slot | null) => {
  const out = new Uint8Array(SLOT_WIRE_LEN)
  if (slot === null) return out
  const view = new DataView(out.buffer)
  out[0] = 1
  out.set(toBytes32(slot.salt), 1)
  out.set(slot.tab, 33)
  view.setUint32(65, slot.seq, true)
  out[69] = slot.dir
  view.setBigUint64(70, slot.debt, true)
  view.setBigUint64(78, slot.cancel, true)
  return out
}

/** The witness the prover reads: the statement body followed by the 28 slots, 86 bytes each. */
export function encodeWitness(statement: NettingStatement, slots: readonly (Slot | null)[]): Uint8Array {
  checkSlots(slots)
  return concatBytes(encodeStatement(statement), ...slots.map(slotWire))
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/** Whether the opening reproduces the statement's root from its own digest and holds `tab` at exactly `seq`. */
export function openingProves(
  opening: LeafOpening,
  statement: NettingStatement,
  tab: Uint8Array,
  seq: number,
): boolean {
  try {
    const { p, slots, digests } = opening
    if (!sameBytes(opening.session, statement.session) || digests.length !== PARTICIPANTS || slots.length !== 7) {
      return false
    }
    checkParticipant(p)
    const full: (Slot | null)[] = Array.from({ length: SLOTS }, () => null)
    let k = 0
    for (let q = 0; q < PARTICIPANTS; q++) {
      if (q !== p) full[slotIndex(Math.min(p, q), Math.max(p, q))] = slots[k++]
    }
    if (digest(sessionField(statement), p, full) !== digests[p]) return false
    if (rootOf(digests) !== fromCanonical(statement.root, 'root')) return false
    return slots.some((slot) => slot !== null && slot.seq === seq && sameBytes(slot.tab, tab))
  } catch {
    return false
  }
}
