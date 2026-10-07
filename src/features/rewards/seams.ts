import type { RewardRecord } from './state'

/**
 * What the phone's claim store offers the rewards screen: its leaves, claiming them to a new address (delayed by a
 * random time unless `immediate`) and moving claimed rewards to the wallet. `claim` and `move` reject with an
 * Error whose message the screen shows.
 */
export type RewardClaims = {
  leaves: () => Promise<readonly RewardRecord[]>
  claim: (options: { immediate: boolean }) => Promise<void>
  move: () => Promise<void>
}

/** What a tip is made of: the fee one word pays, from the reward mint, and the bond of the lock it is paid from. */
export type TipTerms = { wordValue: bigint; bond: bigint }

/** The claim store of this phone. It is not present until the phone prover ships; claiming is not offered without it. */
export function useRewardClaims(): RewardClaims | undefined {
  return undefined
}

/** The terms of a tip; absent until the reward mint is read, and tipping is not offered without them. */
export function useTipTerms(): TipTerms | undefined {
  return undefined
}
