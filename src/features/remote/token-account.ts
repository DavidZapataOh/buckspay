import { type Address, type GetAccountInfoApi, getAddressDecoder, type Rpc } from '@solana/kit'
import { associatedTokenAddress } from '../lock/operations'

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address
export type ContactCheck = 'verified' | 'no-account' | 'not-checked'

const finalized = { commitment: 'finalized', encoding: 'base64' } as const

/** The associated token account of `wallet` for `mint`, under the token program that owns the mint. */
export async function tokenAccountOf(
  rpc: Rpc<GetAccountInfoApi>,
  wallet: Uint8Array,
  mint: Uint8Array,
): Promise<{ account: Address; owner: Address }> {
  const decode = getAddressDecoder()
  const { value } = await rpc.getAccountInfo(decode.decode(mint), finalized).send()
  if (!value) throw new Error('The token does not exist on this network.')
  return {
    account: await associatedTokenAddress(decode.decode(wallet), decode.decode(mint), value.owner),
    owner: value.owner,
  }
}

/** Whether the wallet's token account of `mint` exists and belongs to the token program: the gateway creates none. */
export async function tokenAccountExists(
  rpc: Rpc<GetAccountInfoApi>,
  wallet: Uint8Array,
  mint: Uint8Array,
): Promise<boolean> {
  const { account, owner } = await tokenAccountOf(rpc, wallet, mint)
  const { value } = await rpc.getAccountInfo(account, finalized).send()
  return value !== null && value.owner === owner
}
