import type { NoteDb } from '../notes/db'
import type { RewardClaims } from './seams'
import { leafRecords, loadLeafSecrets, scheduleClaims } from './secrets'
import type { ClaimProgress } from './secrets-claim'

/**
 * The claim store of this phone: its leaves, the claim (delayed by a random time unless asked to be at once) and the
 * move to the wallet, over the route that proves and posts claims.
 */
export function createRewardClaims(deps: {
  db: NoteDb
  route: { advance: (db: NoteDb) => Promise<ClaimProgress> }
  /** The value of the smallest leaf, from the cache when there is one. */
  unit: () => Promise<bigint>
  move: () => Promise<void>
  now: () => number
}): RewardClaims & { advance: () => Promise<ClaimProgress> } {
  const { db, route } = deps
  return {
    advance: () => route.advance(db),
    async leaves() {
      if ((await loadLeafSecrets(db, ['in_tree', 'proving', 'submitted', 'claimed', 'failed'])).length === 0) return []
      return leafRecords(db, await deps.unit())
    },
    async claim({ immediate }) {
      // New leaves are found in the tree first: only a leaf the tree holds can be given a time.
      await route.advance(db)
      await scheduleClaims(db, deps.now(), { immediate })
      await route.advance(db)
      const [failed] = await loadLeafSecrets(db, ['failed'])
      if (failed) throw new Error(failed.error ?? 'A claim failed.')
    },
    move: deps.move,
  }
}
