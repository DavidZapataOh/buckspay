import { equalBytes } from '@noble/curves/utils.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { checkU32, checkU64, checkU8, ProtocolError } from './codec'
import { content, envelope, Purpose } from './hash'

export const MIN_WORD_DEPTH = 4
export const MAX_WORD_DEPTH = 8
export const MIN_LEAF_EXP = 1
export const MAX_LEAF_EXP = 7
export const MAX_WORDS_PER_TX = 256
export const COMMITMENT_LEN = 91
const VERSION = 1
const PAYWORD_KIND = 0x40
const WORD_TAG = utf8ToBytes('buckspay/word')

export interface Commitment {
  mint: Uint8Array
  lockSeq: number
  cumEnd: bigint
  depth: number
  wordValue: bigint
  root: Uint8Array
  expiry: number
}

export function commitmentTotal(c: Commitment): bigint | null {
  const total = c.wordValue << BigInt(c.depth)
  return total < 1n << 64n ? total : null
}

export function encodeCommitment(c: Commitment): Uint8Array {
  if (c.mint.length !== 32 || c.root.length !== 32) throw new ProtocolError('Length')
  checkU32(c.lockSeq)
  checkU64(c.cumEnd)
  checkU8(c.depth)
  checkU64(c.wordValue)
  checkU32(c.expiry)
  const out = new Uint8Array(COMMITMENT_LEN)
  const view = new DataView(out.buffer)
  out[0] = VERSION
  out[1] = PAYWORD_KIND
  out.set(c.mint, 2)
  view.setUint32(34, c.lockSeq, true)
  view.setBigUint64(38, c.cumEnd, true)
  out[46] = c.depth
  view.setBigUint64(47, c.wordValue, true)
  out.set(c.root, 55)
  view.setUint32(87, c.expiry, true)
  return out
}

export function decodeCommitment(bytes: Uint8Array): Commitment {
  if (bytes.length !== COMMITMENT_LEN) throw new ProtocolError('Length')
  if (bytes[0] !== VERSION) throw new ProtocolError('Version')
  if (bytes[1] !== PAYWORD_KIND) throw new ProtocolError('Kind')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const c: Commitment = {
    mint: bytes.slice(2, 34),
    lockSeq: view.getUint32(34, true),
    cumEnd: view.getBigUint64(38, true),
    depth: bytes[46],
    wordValue: view.getBigUint64(47, true),
    root: bytes.slice(55, 87),
    expiry: view.getUint32(87, true),
  }
  if (c.depth < MIN_WORD_DEPTH || c.depth > MAX_WORD_DEPTH) throw new ProtocolError('Depth')
  if (commitmentTotal(c) === null) throw new ProtocolError('Amount')
  return c
}

export const commitmentHash = (c: Commitment) => content(encodeCommitment(c))

/** The word of `index`: independent of every other word, so revealing one reveals nothing else. */
export function deriveWord(seed: Uint8Array, index: number): Uint8Array {
  if (seed.length !== 32) throw new ProtocolError('Length')
  return hmac(sha256, seed, concatBytes(WORD_TAG, indexBytes(index)))
}

function indexBytes(index: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index > 0xffff) throw new ProtocolError('Length')
  return Uint8Array.of(index >> 8, index & 0xff)
}

const leaf = (index: number, word: Uint8Array) => sha256(concatBytes(Uint8Array.of(0), indexBytes(index), word))
const node = (left: Uint8Array, right: Uint8Array) => sha256(concatBytes(Uint8Array.of(1), left, right))

function levels(seed: Uint8Array, depth: number): Uint8Array[][] {
  if (!Number.isInteger(depth) || depth < 1 || depth > MAX_WORD_DEPTH) throw new ProtocolError('Depth')
  let level = Array.from({ length: 1 << depth }, (_, i) => leaf(i, deriveWord(seed, i)))
  const all = [level]
  while (level.length > 1) {
    level = Array.from({ length: level.length / 2 }, (_, i) => node(level[2 * i], level[2 * i + 1]))
    all.push(level)
  }
  return all
}

export const wordRoot = (seed: Uint8Array, depth: number) => levels(seed, depth).at(-1)![0]

/** `index u16 ‖ word 32 ‖ path depth × 32`, the proof a relayer carries. */
export function wordProof(seed: Uint8Array, depth: number, index: number): Uint8Array {
  const all = levels(seed, depth)
  if (index >= 1 << depth) throw new ProtocolError('Length')
  const parts = [indexBytes(index), deriveWord(seed, index)]
  for (let k = 0; k < depth; k++) parts.push(all[k][(index >> k) ^ 1])
  return concatBytes(...parts)
}

export function verifyWord(c: Commitment, proof: Uint8Array): boolean {
  if (proof.length !== 34 + 32 * c.depth) return false
  const index = (proof[0] << 8) | proof[1]
  if (index >= 1 << c.depth) return false
  let h = leaf(index, proof.subarray(2, 34))
  for (let k = 0; k < c.depth; k++) {
    const sibling = proof.subarray(34 + 32 * k, 66 + 32 * k)
    h = (index >> k) & 1 ? node(sibling, h) : node(h, sibling)
  }
  return equalBytes(h, c.root)
}

/** The exponents of the leaves a batch of `words` words appends, as the program derives them. */
export function canonicalExps(words: number): number[] | null {
  if (!Number.isInteger(words) || words < 2 || words % 2 !== 0 || words > MAX_WORDS_PER_TX) return null
  const exps = Array<number>(Math.floor(words / 128)).fill(MAX_LEAF_EXP)
  for (let e = MAX_LEAF_EXP - 1; e >= MIN_LEAF_EXP; e--) if (((words % 128) >> e) & 1) exps.push(e)
  return exps
}

/** The 96-byte envelope the device key signs for a commitment. */
export function paywordEnvelope(domain: Uint8Array, c: Commitment): Uint8Array {
  const body = encodeCommitment(c)
  const slot = sha256(concatBytes(utf8ToBytes(Purpose.PayWord), body))
  return envelope(domain, slot, content(body))
}
