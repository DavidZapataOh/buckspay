/** The sizes the inner message is padded to: its length reveals at most the bucket. */
export const BUCKETS = [1024, 2048, 4096, 8192] as const
export const MAX_SPENDS = 16

/** `version 1 ‖ kind 1 ‖ issueLen u16 ‖ issue ‖ n u8 ‖ (len u16 ‖ spend) × n`, zero-padded to the smallest bucket that holds it. */
export function encodeInner(issue: Uint8Array, spends: readonly Uint8Array[]): Uint8Array {
  if (spends.length < 1 || spends.length > MAX_SPENDS) throw new Error('A relayed note carries one to sixteen spends.')
  const size = 2 + 2 + issue.length + 1 + spends.reduce((sum, spend) => sum + 2 + spend.length, 0)
  const bucket = BUCKETS.find((candidate) => candidate >= size)
  if (!bucket || issue.length > 0xffff || spends.some((spend) => spend.length > 0xffff))
    throw new Error('The note is too large to relay.')
  const out = new Uint8Array(bucket)
  const view = new DataView(out.buffer)
  out.set([1, 1])
  view.setUint16(2, issue.length)
  out.set(issue, 4)
  let at = 4 + issue.length
  out[at++] = spends.length
  for (const spend of spends) {
    view.setUint16(at, spend.length)
    out.set(spend, at + 2)
    at += 2 + spend.length
  }
  return out
}
