import { signPayword } from '../../keys'
import { useDeviceIdentity } from '../identity/use-device-identity'
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

/** Signs a payment-word channel commitment with the device key. */
export type PaywordSigner = typeof signPayword

/** The device key signs payment words; without a key there is nothing to sign with and tipping is not offered. */
export function usePaywordSigner(): PaywordSigner | undefined {
  const { deviceKey } = useDeviceIdentity()
  return deviceKey ? signPayword : undefined
}
