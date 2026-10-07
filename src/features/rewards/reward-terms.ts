import { fetchMaybeRewardMint } from '@project/anchor'
import {
  type Address,
  type GetAccountInfoApi,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Rpc,
} from '@solana/kit'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { TipTerms } from './seams'

const STORE = 'reward-terms:v1'

/** What the reward mint's account says that the screens need: the value of the smallest leaf and the fee one word pays. */
export type MintTerms = { unit: bigint; wordValue: bigint }

/** The last terms read from the chain, or none when they were never read or the stored value is damaged. */
export async function loadMintTerms(): Promise<MintTerms | undefined> {
  const stored = await AsyncStorage.getItem(STORE)
  if (!stored) return undefined
  try {
    const { unit, wordValue } = JSON.parse(stored) as { unit: string; wordValue: string }
    return { unit: BigInt(unit), wordValue: BigInt(wordValue) }
  } catch {
    return undefined
  }
}

export async function saveMintTerms({ unit, wordValue }: MintTerms): Promise<void> {
  await AsyncStorage.setItem(STORE, JSON.stringify({ unit: unit.toString(), wordValue: wordValue.toString() }))
}

/** The terms from the cache; only when there are none are they read, so a phone without internet still shows its rewards. */
export async function cachedMintTerms(read: () => Promise<MintTerms>): Promise<MintTerms> {
  const stored = await loadMintTerms()
  if (stored) return stored
  const terms = await read()
  await saveMintTerms(terms)
  return terms
}

export async function readMintTerms(
  rpc: Rpc<GetAccountInfoApi>,
  programAddress: Address,
  mint: Address,
): Promise<MintTerms> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [new TextEncoder().encode('reward-mint'), getAddressEncoder().encode(mint)],
  })
  const account = await fetchMaybeRewardMint(rpc, pda, { commitment: 'confirmed' })
  if (!account.exists) throw new Error('This mint pays no rewards.')
  return { unit: account.data.unit, wordValue: account.data.wordValue }
}

/**
 * What a tip is made of. The bond is the largest among the locks the phone holds a ticket for, so it is known offline;
 * a phone with no lock has none, and the settings say why tipping is off. Absent until the mint was read and while a
 * word cannot be signed.
 */
export function tipTerms(
  mint: MintTerms | undefined,
  bonds: readonly bigint[],
  canSign: boolean,
): TipTerms | undefined {
  if (!mint || !canSign) return undefined
  return { wordValue: mint.wordValue, bond: bonds.reduce((most, bond) => (bond > most ? bond : most), 0n) }
}
