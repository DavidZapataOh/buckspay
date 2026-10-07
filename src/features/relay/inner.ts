/** The sizes the inner message is padded to: its length reveals at most the bucket. */
export const BUCKETS = [1024, 2048, 4096, 8192] as const
export const MAX_SPENDS = 16

/** The word of a payment's tip: `commitment ‖ signature ‖ proofLen u16 ‖ proof`. */
export function encodeWord(commitment: Uint8Array, signature: Uint8Array, proof: Uint8Array): Uint8Array {
  const out = new Uint8Array(commitment.length + signature.length + 2 + proof.length)
  out.set(commitment)
  out.set(signature, commitment.length)
  new DataView(out.buffer).setUint16(commitment.length + signature.length, proof.length)
  out.set(proof, commitment.length + signature.length + 2)
  return out
}

/**
 * `version 1 ‖ kind 1 ‖ issueLen u16 ‖ issue ‖ n u8 ‖ (len u16 ‖ spend) × n`, zero-padded to the smallest bucket that holds
 * it. With a tip, the kind is 2 and the word follows the spends.
 */
export function encodeInner(issue: Uint8Array, spends: readonly Uint8Array[], word?: Uint8Array): Uint8Array {
  if (spends.length > MAX_SPENDS) throw new Error('A relayed note carries at most sixteen spends.')
  const size = 2 + 2 + issue.length + 1 + spends.reduce((sum, spend) => sum + 2 + spend.length, 0) + (word?.length ?? 0)
  const bucket = BUCKETS.find((candidate) => candidate >= size)
  if (!bucket || issue.length > 0xffff || spends.some((spend) => spend.length > 0xffff))
    throw new Error('The note is too large to relay.')
  const out = new Uint8Array(bucket)
  const view = new DataView(out.buffer)
  out.set([1, word ? 2 : 1])
  view.setUint16(2, issue.length)
  out.set(issue, 4)
  let at = 4 + issue.length
  out[at++] = spends.length
  for (const spend of spends) {
    view.setUint16(at, spend.length)
    out.set(spend, at + 2)
    at += 2 + spend.length
  }
  if (word) out.set(word, at)
  return out
}
