/** A seeded 32-bit xorshift: a number in [0, 1) per call. */
export function seeded(seed: number): () => number {
  let state = seed | 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}
