import { type Address, getBase64Encoder, type GetMultipleAccountsApi, type Rpc } from '@solana/kit'
import { associatedTokenAddress } from './operations'

/** The wallet's token account of the funding mint, which pays for locks. */
export type Funding = { mint: Address; tokenProgram: Address; account: Address; decimals: number; balance: bigint }

const MINT_DECIMALS_OFFSET = 44
const TOKEN_AMOUNT_OFFSET = 64

const read = async (rpc: Rpc<GetMultipleAccountsApi>, address: Address) => {
  const {
    value: [account],
  } = await rpc.getMultipleAccounts([address], { commitment: 'confirmed', encoding: 'base64' }).send()
  return account && { owner: account.owner, data: Uint8Array.from(getBase64Encoder().encode(account.data[0])) }
}

/**
 * The wallet's balance of `mint` in its associated token account, with the token's decimals. The
 * mint's owner is the token program, so classic and Token-2022 mints are both read.
 */
export async function readFunding(rpc: Rpc<GetMultipleAccountsApi>, wallet: Address, mint: Address): Promise<Funding> {
  const mintAccount = await read(rpc, mint)
  if (!mintAccount) throw new Error('The funding token does not exist on this network.')
  const tokenProgram = mintAccount.owner
  const account = await associatedTokenAddress(wallet, mint, tokenProgram)
  const tokenAccount = await read(rpc, account)
  const balance = tokenAccount ? new DataView(tokenAccount.data.buffer).getBigUint64(TOKEN_AMOUNT_OFFSET, true) : 0n
  return { mint, tokenProgram, account, decimals: mintAccount.data[MINT_DECIMALS_OFFSET], balance }
}
