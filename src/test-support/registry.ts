import { hexToBytes } from '@noble/curves/utils.js'

import type vectors from '../../anchor/crates/protocol/tests/vectors/v1.json'
import type { Attester } from '../protocol'

/** An attester as a wallet would hold it after a registry read, from an entry of the committed vectors. */
export const registryEntry = (entry: (typeof vectors.registry)[number]): Attester => ({
  id: entry.id,
  authority: hexToBytes(entry.authority),
  mint: hexToBytes(entry.mint),
  stake: BigInt(entry.stake),
  key: hexToBytes(entry.key),
  prevKey: hexToBytes(entry.prev_key),
  prevTrustedUntil: entry.prev_trusted_until,
  revoked: [hexToBytes(entry.revoked[0]), hexToBytes(entry.revoked[1])],
  syncedAt: entry.synced_at,
  active: entry.active,
  relied: BigInt(entry.relied),
})
