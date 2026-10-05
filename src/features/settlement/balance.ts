import type { Address, Rpc, SolanaRpcApi } from '@solana/kit'

/**
 * What `owner` holds of `mint` across every token account it owns, in base units. A payment may be
 * settled into any token account the payee owns, not only the associated one.
 */
export async function mintBalance(
  rpc: Rpc<Pick<SolanaRpcApi, 'getTokenAccountsByOwner'>>,
  owner: Address,
  mint: Address,
): Promise<bigint> {
  const { value } = await rpc.getTokenAccountsByOwner(owner, { mint }, { encoding: 'jsonParsed' }).send()
  return value.reduce((sum, { account }) => sum + BigInt(account.data.parsed.info.tokenAmount.amount), 0n)
}
