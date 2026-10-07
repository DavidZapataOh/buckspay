import { address, getAddressEncoder } from '@solana/kit'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { useCallback, useMemo } from 'react'
import { Platform } from 'react-native'
import { deviceKeyCluster } from '../../keys'
import { genesisHashOf } from '../../payment/domains'
import { ACTIVE_PROFILE } from '../../protocol/active-profile'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { BUILD_GATEWAY, BUILD_GATEWAY_URL } from '../lock/gateway'
import { BUILD_FUNDING_MINT } from '../lock/build-funding'
import { nowSeconds, usePayments } from '../payment/payments-provider'
import { BUILD_MINT_BYTES, BUILD_TOKEN } from '../pay/tokens'
import { BUILD_PINS } from '../zk/pins'
import { claimProverNative } from '../zk/native'
import { createRewardClaims } from './claims'
import { moveRewards, rpcSweepChain } from './move'
import { cachedMintTerms, readMintTerms } from './reward-terms'
import { createRewardsRoute, rewardChain } from './secrets-device'
import type { RewardClaims } from './seams'
import { sweepQuote } from './sweep-quote'

const PROGRAM_ADDRESS = address(ACTIVE_PROFILE.programId)

/**
 * The claim store of this phone, built where the wallet's RPC is available. Absent without the pieces a claim needs:
 * an open store, a connected wallet, the cluster of the device key and the gateway of this build.
 */
function useClaimStore() {
  const { db } = usePayments()
  const { device } = useDeviceIdentity()
  const { client } = useMobileWallet()
  const wallet = device?.wallet
  const rpc = client.rpc
  return useMemo(() => {
    const cluster = deviceKeyCluster()
    const gateway = BUILD_GATEWAY
    const gatewayUrl = BUILD_GATEWAY_URL
    if (Platform.OS !== 'android' || !db || !wallet || !cluster || !gateway || !gatewayUrl) return undefined
    const route = createRewardsRoute({
      chain: rewardChain(rpc, PROGRAM_ADDRESS, BUILD_FUNDING_MINT),
      programId: Uint8Array.from(getAddressEncoder().encode(PROGRAM_ADDRESS)),
      mint: BUILD_MINT_BYTES,
      gatewayUrl,
      gateway,
      genesisHash: genesisHashOf(cluster),
      pins: BUILD_PINS,
      prover: claimProverNative,
      now: nowSeconds,
    })
    return createRewardClaims({
      db,
      route,
      unit: async () => (await cachedMintTerms(() => readMintTerms(rpc, PROGRAM_ADDRESS, BUILD_FUNDING_MINT))).unit,
      move: async () => {
        await moveRewards({
          db,
          destination: wallet,
          mint: BUILD_FUNDING_MINT,
          decimals: BUILD_TOKEN.decimals,
          chain: rpcSweepChain(rpc, BUILD_FUNDING_MINT),
          quote: sweepQuote(gatewayUrl),
          gateway,
        })
      },
      now: nowSeconds,
    })
  }, [db, wallet, rpc])
}

/** The claim store for the rewards screen; `undefined` while the pieces it needs are not there. */
export function useRewardClaims(): RewardClaims | undefined {
  return useClaimStore()
}

/**
 * Moves the claims along in the background: finds the new leaves of this phone and proves and posts the ones whose time
 * has come. A failure is kept on the leaf by the route; one that stops the run (no network) is logged and the next run
 * of the app tries again.
 */
export function useRewardsAdvance(): (() => Promise<void>) | undefined {
  const store = useClaimStore()
  return useCallback(async () => {
    try {
      await store?.advance()
    } catch (failure) {
      console.warn('Reward claims did not advance', failure)
    }
  }, [store])
}
