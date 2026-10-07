import { fetchMaybeZkConfig } from '@project/anchor'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  type Address,
  type GetAccountInfoApi,
  getProgramDerivedAddress,
  type ReadonlyUint8Array,
  type Rpc,
} from '@solana/kit'
import { GRACE } from '../../protocol'
import { type ChainKeys, trustedKey } from './key'
import type { KeyHashes, KeyOffer } from './types'

/** How long a note made before a rotation can still settle: three days of life, then the grace. */
const PREVIOUS_LIFE = 72 * 3600 + GRACE

/** What the gateway publishes of the keys; the app trusts none of it until the chain or the build pin agrees. */
export type ZkConfigAnswer = { current: KeyOffer; previous?: KeyOffer & { validUntil: number } }

type OnChainKeys = { vk: ReadonlyUint8Array; pk: ReadonlyUint8Array; dump: ReadonlyUint8Array; ccs: ReadonlyUint8Array }

const hex = (bytes: ReadonlyUint8Array) => bytesToHex(Uint8Array.from(bytes))

const hashesOf = (keys: OnChainKeys): KeyHashes => ({
  vkSha256: hex(keys.vk),
  pkSha256: hex(keys.pk),
  ccsSha256: hex(keys.ccs),
  dumpSha256: hex(keys.dump),
})

/** The keys of a `ZkConfig` account: the current one, and the previous while a rotation's window is open. */
export function chainKeysOf(config: { current: OnChainKeys; previous: OnChainKeys; rotatedAt: bigint }): ChainKeys {
  const current = hashesOf(config.current)
  if (config.rotatedAt === 0n) return { current }
  return { current, previous: { ...hashesOf(config.previous), validUntil: Number(config.rotatedAt) + PREVIOUS_LIFE } }
}

/** Reads the keys the program announces; null when the program has no `ZkConfig` or the cluster cannot be read. */
export async function readChainKeys(rpc: Rpc<GetAccountInfoApi>, programAddress: Address): Promise<ChainKeys | null> {
  try {
    const [address] = await getProgramDerivedAddress({ programAddress, seeds: [new TextEncoder().encode('zk-config')] })
    const account = await fetchMaybeZkConfig(rpc, address, { commitment: 'confirmed' })
    return account.exists ? chainKeysOf(account.data) : null
  } catch {
    return null
  }
}

/**
 * The key this phone may download and use: the one the gateway offers, if the chain or the build pin vouches for it.
 * With no offer there is nothing to download, whatever the pin says.
 */
export function createKeyResolver(deps: {
  zkConfig: () => Promise<ZkConfigAnswer>
  readChain: () => Promise<ChainKeys | null>
  pins: KeyHashes[]
  now: () => number
}) {
  return async (): Promise<KeyOffer | undefined> => {
    try {
      const [offered, chain] = await Promise.all([deps.zkConfig(), deps.readChain()])
      return trustedKey(offered.current, deps.pins, chain, deps.now()) ? offered.current : undefined
    } catch {
      return undefined
    }
  }
}
