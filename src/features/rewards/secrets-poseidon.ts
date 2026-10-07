import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { POSEIDON_MDS, POSEIDON_ROUNDS } from './secrets-constants'

/** The order of the BN254 scalar field, the modulus of every value the claim circuit and the program hash. */
export const BN254_R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n

const FULL_ROUNDS = 8
const PARTIAL_ROUNDS = 57

const isFull = (round: number) => round < FULL_ROUNDS / 2 || round >= FULL_ROUNDS / 2 + PARTIAL_ROUNDS

const sbox = (x: bigint) => {
  const x2 = (x * x) % BN254_R
  return (x * ((x2 * x2) % BN254_R)) % BN254_R
}

/**
 * Reads a 32-byte big-endian field element, refusing a value of r or more. The circuit's hash reduces such a value
 * and the syscall refuses it, so every value is checked here, before it is hashed.
 */
export function fromCanonical(bytes: Uint8Array, name: string): bigint {
  if (bytes.length !== 32) throw new Error(`${name} must be 32 bytes`)
  const value = BigInt(`0x${bytesToHex(bytes)}`)
  if (value >= BN254_R) throw new Error(`${name} is not below the field order`)
  return value
}

export function toBytes32(value: bigint): Uint8Array {
  if (value < 0n || value >= BN254_R) throw new Error('A field element is below the field order')
  return hexToBytes(value.toString(16).padStart(64, '0'))
}

/** Poseidon of two field elements, as the claim circuit and the `sol_poseidon` syscall compute it. */
export function poseidon2(a: bigint, b: bigint): bigint {
  if (a < 0n || a >= BN254_R || b < 0n || b >= BN254_R) throw new Error('Poseidon takes values below the field order')
  let state = [0n, a, b]
  for (let round = 0; round < POSEIDON_ROUNDS.length; round++) {
    const keyed = state.map((value, i) => (value + POSEIDON_ROUNDS[round][i]) % BN254_R)
    const mixed = keyed.map((value, i) => (i === 0 || isFull(round) ? sbox(value) : value))
    state = POSEIDON_MDS.map((row) => row.reduce((sum, m, j) => (sum + m * mixed[j]) % BN254_R, 0n))
  }
  return state[0]
}
