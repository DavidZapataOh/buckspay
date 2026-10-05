import { address } from '@solana/kit'
import { describe, expect, it, vi } from 'vitest'
import { mintBalance } from './balance'

const owner = address('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS')
const mint = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
const account = (amount: string) => ({ account: { data: { parsed: { info: { tokenAmount: { amount } } } } } })
const rpcOf = (amounts: string[]) => {
  const getTokenAccountsByOwner = vi.fn(() => ({ send: async () => ({ value: amounts.map(account) }) }))
  return { rpc: { getTokenAccountsByOwner } as never, getTokenAccountsByOwner }
}

describe('the balance of a mint', () => {
  it('adds up every token account of the wallet, not only the associated one', async () => {
    const { rpc, getTokenAccountsByOwner } = rpcOf(['1500000', '250000', '18446744073709551615'])
    expect(await mintBalance(rpc, owner, mint)).toBe(1_500_000n + 250_000n + 18_446_744_073_709_551_615n)
    expect(getTokenAccountsByOwner).toHaveBeenCalledWith(owner, { mint }, { encoding: 'jsonParsed' })
  })

  it('is zero for a wallet with no token account of the mint', async () => {
    expect(await mintBalance(rpcOf([]).rpc, owner, mint)).toBe(0n)
  })
})
