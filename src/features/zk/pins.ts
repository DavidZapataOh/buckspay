import Constants from 'expo-constants'
import type { KeyHashes } from './types'

const HASH = /^[0-9a-f]{64}$/

/** Reads the key hashes a build pinned (`extra.zk` of the app configuration); anything malformed is dropped. */
export function parsePins(extra: unknown): KeyHashes[] {
  if (!Array.isArray(extra)) return []
  return extra.flatMap((entry: Record<string, unknown> | null) => {
    const { vkSha256, pkSha256, ccsSha256, dumpSha256 } = entry ?? {}
    const all = [vkSha256, pkSha256, ccsSha256, dumpSha256]
    return all.every((hash) => typeof hash === 'string' && HASH.test(hash))
      ? [{ vkSha256, pkSha256, ccsSha256, dumpSha256 } as KeyHashes]
      : []
  })
}

export const BUILD_PINS = parsePins(Constants.expoConfig?.extra?.zk)
