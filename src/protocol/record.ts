import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { checkBytes } from './codec'

export const SPENT_SEED = utf8ToBytes('spent')
/** The only bump a record address is derived with. */
export const RECORD_BUMP = 255
const DERIVED_ADDRESS = utf8ToBytes('ProgramDerivedAddress')

/**
 * The record address of `output` under `program`: the program-derived address of
 * `["spent", output, 255]`, or `undefined` when the output cannot be recorded because that address
 * is on the Ed25519 curve (about half of all ids). The twin of `record::address`.
 */
export function recordAddress(program: Uint8Array, output: Uint8Array): Uint8Array | undefined {
  checkBytes(program, 32)
  checkBytes(output, 32)
  const address = sha256(concatBytes(SPENT_SEED, output, Uint8Array.of(RECORD_BUMP), program, DERIVED_ADDRESS))
  try {
    ed25519.Point.fromBytes(address)
    return undefined
  } catch {
    return address
  }
}
