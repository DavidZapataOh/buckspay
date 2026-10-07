import { fetchMaybeRewardConfig, fetchMaybeRewardMint, fetchMaybeRewardTree } from '@project/anchor'
import {
  type Address,
  type GetAccountInfoApi,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU32Encoder,
  type Rpc,
} from '@solana/kit'
import type { RewardsGateway } from '../lock/gateway'
import type { NoteDb } from '../notes/db'
import { type ChainKeys, trustedKey } from '../zk/key'
import type { ClaimProverNative } from '../zk/native'
import { chainKeysOf } from '../zk/trusted-key'
import type { KeyHashes, KeyOffer } from '../zk/types'
import { loadLeafSecrets, locateLeaves } from './secrets'
import { advanceClaims, type ClaimProgress, fetchRewardLeaves, rewardScope } from './secrets-claim'

/** Roots the program keeps per tree: the latest is the one pushed last. */
const ROOT_HISTORY = 256
const text = new TextEncoder()
const COMMITMENT = { commitment: 'confirmed' } as const

/** What the phone reads from the reward accounts of the program. */
export type RewardChain = {
  /** The tree epoch new leaves go into, the fixed fee ceiling and the value of the smallest leaf. */
  mint(): Promise<{ epoch: number; maxFee: bigint; unit: bigint }>
  /** The latest root of an epoch's tree and how many leaves it holds. */
  tree(epoch: number): Promise<{ root: Uint8Array; leafCount: number }>
  /** The claim keys the program accepts, or null when it announces none. */
  claimKeys(): Promise<ChainKeys | null>
}

export function rewardChain(rpc: Rpc<GetAccountInfoApi>, programAddress: Address, mint: Address): RewardChain {
  const address = (seeds: Uint8Array[]) => getProgramDerivedAddress({ programAddress, seeds })
  const mintBytes = Uint8Array.from(getAddressEncoder().encode(mint))
  return {
    async mint() {
      const [pda] = await address([text.encode('reward-mint'), mintBytes])
      const account = await fetchMaybeRewardMint(rpc, pda, COMMITMENT)
      if (!account.exists) throw new Error('This mint pays no rewards.')
      return { epoch: account.data.epoch, maxFee: account.data.maxFee, unit: account.data.unit }
    },
    async tree(epoch) {
      const [pda] = await address([
        text.encode('reward-tree'),
        mintBytes,
        Uint8Array.from(getU32Encoder().encode(epoch)),
      ])
      const account = await fetchMaybeRewardTree(rpc, pda, COMMITMENT)
      if (!account.exists || account.data.rootIndex === 0) throw new Error('The reward tree of this epoch is empty.')
      const { roots, rootIndex, nextIndex } = account.data
      return { root: Uint8Array.from(roots[(rootIndex - 1) % ROOT_HISTORY]), leafCount: nextIndex }
    },
    async claimKeys() {
      const [pda] = await address([text.encode('reward-config')])
      const account = await fetchMaybeRewardConfig(rpc, pda, COMMITMENT)
      if (!account.exists) return null
      const { claimKey, previousClaimKey, rotatedAt } = account.data
      return chainKeysOf({ current: claimKey, previous: previousClaimKey, rotatedAt })
    },
  }
}

/**
 * The reward claims of this phone. The chain is the authority: the epoch and the fee ceiling come from the mint's
 * account, a proof is made against the latest root of the epoch's tree, and the claim key is used only if the program or
 * the build vouches for it. The gateway supplies the leaves (checked against that root) and the files of the key.
 */
export function createRewardsRoute(deps: {
  chain: RewardChain
  programId: Uint8Array
  mint: Uint8Array
  gatewayUrl: string
  gateway: Pick<RewardsGateway, 'submitClaims' | 'claimStatus'>
  genesisHash: Uint8Array
  pins: KeyHashes[]
  prover: ClaimProverNative
  now: () => number
  request?: typeof fetch
}) {
  const request = deps.request ?? fetch
  const leaves = fetchRewardLeaves(deps.gatewayUrl, request)

  async function tree(epoch: number) {
    const { root, leafCount } = await deps.chain.tree(epoch)
    const all = await leaves(epoch)
    if (all.length < leafCount) throw new Error('The gateway’s reward tree is behind the chain.')
    return { leaves: all.slice(0, leafCount), root }
  }

  async function claimKey(): Promise<KeyOffer | undefined> {
    const response = await request(`${deps.gatewayUrl}/v1/rewards/key`)
    if (!response.ok) throw new Error(`The gateway answered ${response.status}.`)
    const offer = (await response.json()) as KeyOffer
    return trustedKey(offer, deps.pins, await deps.chain.claimKeys(), deps.now()) ? offer : undefined
  }

  return {
    /** The value of the smallest unit a leaf pays; a leaf of exponent `e` pays `unit * 2^e`. */
    async unit(): Promise<bigint> {
      return (await deps.chain.mint()).unit
    },
    /** Finds the new leaves of this phone and moves the scheduled claims along. */
    async advance(db: NoteDb): Promise<ClaimProgress> {
      if ((await loadLeafSecrets(db)).length === 0)
        return { enqueued: 0, submitted: 0, claimed: 0, failed: 0, waiting: 0 }
      const mint = await deps.chain.mint()
      if ((await loadLeafSecrets(db, ['made'])).length > 0)
        await locateLeaves(db, mint.epoch, (await tree(mint.epoch)).leaves)
      return advanceClaims(db, {
        now: deps.now(),
        scope: rewardScope(deps.programId, deps.mint, deps.genesisHash),
        maxFee: mint.maxFee,
        tree,
        latestRoot: async (epoch) => (await deps.chain.tree(epoch)).root,
        key: claimKey,
        prover: deps.prover,
        gateway: deps.gateway,
      })
    },
  }
}
