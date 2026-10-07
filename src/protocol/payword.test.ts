import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import vectors from '../../anchor/crates/protocol/tests/vectors/v1.json'
import { DEVNET_GENESIS_HASH } from './cluster'
import { domain, Purpose } from './hash'
import {
  canonicalExps,
  commitmentHash,
  decodeCommitment,
  deriveWord,
  encodeCommitment,
  paywordEnvelope,
  verifyWord,
  wordProof,
  wordRoot,
} from './payword'

const v = vectors.payword
const seed = hexToBytes(v.seed)

describe('payword', () => {
  it('derives words as the HMAC of the seed, independently of the helper', () => {
    const message = new Uint8Array([...utf8ToBytes('buckspay/word'), 0, 5])
    expect(bytesToHex(deriveWord(seed, 5))).toBe(bytesToHex(hmac(sha256, seed, message)))
    expect(bytesToHex(deriveWord(seed, 5))).toBe(v.word5)
  })

  it('matches the Rust golden vectors byte for byte', () => {
    const commitment = decodeCommitment(hexToBytes(v.commitment))
    expect(bytesToHex(encodeCommitment(commitment))).toBe(v.commitment)
    expect(bytesToHex(commitmentHash(commitment))).toBe(v.commitment_hash)
    expect(bytesToHex(wordRoot(seed, 3))).toBe(v.root3)
    expect(bytesToHex(wordRoot(seed, 6))).toBe(v.root6)
    expect(bytesToHex(commitment.root)).toBe(v.root6)
    for (const { index, proof } of v.proofs6) {
      expect(bytesToHex(wordProof(seed, 6, index))).toBe(proof)
    }
    const programDomain = domain(Purpose.PayWord, DEVNET_GENESIS_HASH, new Uint8Array(32).fill(0xb0))
    expect(bytesToHex(paywordEnvelope(programDomain, commitment))).toBe(v.envelope)
  })

  it('matches the canonical decomposition of Rust', () => {
    for (const { words, exps } of v.exps) expect(canonicalExps(words)).toEqual(exps)
    for (const odd of [0, 1, 3, 255, 258]) expect(canonicalExps(odd)).toBeNull()
  })

  it('verifies its own proofs and rejects one flipped bit anywhere', () => {
    const commitment = decodeCommitment(hexToBytes(v.commitment))
    const proof = wordProof(seed, commitment.depth, 7)
    expect(verifyWord(commitment, proof)).toBe(true)
    for (const at of [0, 1, 2, 33, 34, 100, proof.length - 1]) {
      const bad = proof.slice()
      bad[at] ^= 1
      expect(verifyWord(commitment, bad), `byte ${at}`).toBe(false)
    }
    expect(verifyWord(commitment, proof.slice(0, -1))).toBe(false)
  })

  it('refuses a commitment of another kind, length or depth', () => {
    const bytes = hexToBytes(v.commitment)
    expect(() => decodeCommitment(bytes.slice(1))).toThrow()
    const kind = bytes.slice()
    kind[1] = 0x01
    expect(() => decodeCommitment(kind)).toThrow()
    for (const depth of [0, 3, 9]) {
      const bad = bytes.slice()
      bad[46] = depth
      expect(() => decodeCommitment(bad)).toThrow()
    }
  })
})
