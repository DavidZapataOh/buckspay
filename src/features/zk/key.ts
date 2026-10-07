import type { KeyHashes } from './types'

/** The key the program announces, and the previous one with the last second it may still be used. */
export type ChainKeys = { current: KeyHashes; previous?: KeyHashes & { validUntil: number } }

const same = (a: KeyHashes, b: KeyHashes) =>
  a.vkSha256 === b.vkSha256 && a.pkSha256 === b.pkSha256 && a.ccsSha256 === b.ccsSha256 && a.dumpSha256 === b.dumpSha256

/**
 * Whether `candidate` may be downloaded and used. The program's `ZkConfig` decides when the app can read it:
 * the current key, or the previous one until its window ends. The hashes the build pinned are the answer only
 * when the chain cannot be read; hashes served by the gateway alone are never trusted.
 */
export function trustedKey(candidate: KeyHashes, pins: KeyHashes[], chain: ChainKeys | null, now: number): boolean {
  if (!chain) return pins.some((pin) => same(pin, candidate))
  if (same(chain.current, candidate)) return true
  return chain.previous !== undefined && now <= chain.previous.validUntil && same(chain.previous, candidate)
}
