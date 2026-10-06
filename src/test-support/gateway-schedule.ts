import { x25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { PinnedKey } from '../protocol/hpke'

export const TEST_START = 1_800_000_000
export const TEST_SLOT = 30 * 86_400

/** The X25519 secret of the test gateway key at `index`: tests play the gateway with it. */
export const testSecret = (index: number) => new Uint8Array(32).fill(index * 17 + 5)

/** The shape of `PINNED_GATEWAY_KEYS`: thirteen 30-day slots from `start`. */
export function testSchedule(start = TEST_START, slot = TEST_SLOT, count = 13): PinnedKey[] {
  return Array.from({ length: count }, (_, index) => {
    const publicKey = x25519.getPublicKey(testSecret(index))
    return {
      keyId: sha256(publicKey)[0],
      publicKey,
      notBefore: start + index * slot,
      notAfter: start + (index + 1) * slot,
    }
  })
}

/** What a build of the tests pins, in the `EXPO_PUBLIC_GATEWAY_HPKE_KEYS` format. */
export const testScheduleEnv = () =>
  JSON.stringify(testSchedule().map((key) => ({ ...key, publicKey: btoa(String.fromCharCode(...key.publicKey)) })))
