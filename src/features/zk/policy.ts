import { sha256 } from '@noble/hashes/sha2.js'
import type { ProvingMode } from './types'

const HOUR = 3600
/** The proofs of a note must be ready this long before it can no longer settle. */
const DEADLINE_MARGIN = 24 * HOUR
const DEADLINE_LOOKAHEAD = 24 * HOUR

/** A note passes through the zero-knowledge route only when someone other than issuer and payee held it. */
export const privatePath = ({ spends }: { spends: number }) => spends >= 2

/**
 * When the phone proves. On request at once; off the charger only when the note is about to run out of time
 * (its settle-by time less a margin is less than a day away); otherwise while charging.
 */
export function provingMode({
  userAsked,
  now,
  settleBy,
}: {
  userAsked: boolean
  now: number
  settleBy: number
}): ProvingMode {
  if (userAsked) return 'now'
  return settleBy - DEADLINE_MARGIN - now < DEADLINE_LOOKAHEAD ? 'deadline' : 'charging'
}

/** The messages of a chain of `total` that have no proof under the key `vkSha256`. */
export function missing(total: number, proofs: { index: number; vkSha256: string }[], vkSha256: string): number[] {
  const done = new Set(proofs.filter((proof) => proof.vkSha256 === vkSha256).map((proof) => proof.index))
  return Array.from({ length: total }, (_, index) => index).filter((index) => !done.has(index))
}

/** A private settlement is held back by up to this long after its last proof, so the proving time says nothing of the payment. */
export const SUBMIT_SPREAD = 30 * 60

/**
 * The second from which a note whose proofs were ready at `readyAt` is submitted: at once when the user asked,
 * otherwise after a delay spread evenly over `SUBMIT_SPREAD` by the note's id, so a retry keeps the same one.
 */
export function submitAt({ noteId, readyAt, userAsked }: { noteId: string; readyAt: number; userAsked: boolean }) {
  if (userAsked) return readyAt
  const [a, b, c, d] = sha256(new TextEncoder().encode(noteId))
  return readyAt + ((((a << 24) | (b << 16) | (c << 8) | d) >>> 0) % SUBMIT_SPREAD)
}
