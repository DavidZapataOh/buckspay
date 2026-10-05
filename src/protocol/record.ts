import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { checkBytes } from './codec'

export const SPENT_SEED = utf8ToBytes('spent')
export const CLAIM_SEED = utf8ToBytes('claim')
/** The only bump a record or claim address is derived with. */
export const RECORD_BUMP = 255
const DERIVED_ADDRESS = utf8ToBytes('ProgramDerivedAddress')

function derive(seed: Uint8Array, program: Uint8Array, output: Uint8Array): Uint8Array | undefined {
  checkBytes(program, 32)
  checkBytes(output, 32)
  const address = sha256(concatBytes(seed, output, Uint8Array.of(RECORD_BUMP), program, DERIVED_ADDRESS))
  try {
    ed25519.Point.fromBytes(address)
    return undefined
  } catch {
    return address
  }
}

/**
 * The record address of `output` under `program`: the program-derived address of
 * `['spent', output, 255]`, or `undefined` when the output cannot be recorded because that address
 * is on the Ed25519 curve (about half of all ids). The twin of `record::address`.
 */
export const recordAddress = (program: Uint8Array, output: Uint8Array) => derive(SPENT_SEED, program, output)

/** The claim address of `output`, or `undefined` when the output cannot be claimed. */
export const claimAddress = (program: Uint8Array, output: Uint8Array) => derive(CLAIM_SEED, program, output)

/**
 * Whether an output can be accepted from a payer: it has a record address, for the settlement of
 * its chain, and a claim address, for the burn if the chain is a fraud. The twin of `record::recordable`.
 */
export const isRecordable = (program: Uint8Array, output: Uint8Array) =>
  recordAddress(program, output) !== undefined && claimAddress(program, output) !== undefined
