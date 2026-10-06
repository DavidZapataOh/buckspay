import { ProtocolError } from '../protocol'

/**
 * How many candidates a signer tries before it gives up. An output is recordable when both its
 * record and its claim address are off the curve, one chance in four, so a message with two
 * outputs passes one draw in sixteen. 1024 draws all fail with probability (15/16)^1024, about 2^-95.
 */
export const SALT_TRIES = 1024

export const randomSalt = () => crypto.getRandomValues(new Uint8Array(16))

/**
 * Tries `first` and then `salted(salt)` with a fresh salt per attempt until `check` stops refusing
 * a candidate for lack of a record address, and returns the first that passes. Any other refusal
 * is the caller's to hear at once. Candidates are never modified.
 */
export function withRecordableOutputs<T>(
  first: T,
  salted: (salt: Uint8Array) => T,
  check: (candidate: T) => void,
  draw: () => Uint8Array = randomSalt,
): T {
  let candidate = first
  for (let tries = 0; tries < SALT_TRIES; tries++) {
    try {
      check(candidate)
      return candidate
    } catch (error) {
      if (!(error instanceof ProtocolError) || error.code !== 'Unrecordable') throw error
      candidate = salted(draw())
    }
  }
  throw new ProtocolError('Unrecordable')
}
