import { address, getBase64Decoder } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { associatedTokenAddress } from './operations'
import { readFunding } from './funding'

const WALLET = address('EUhWSZAfU8hDki7AXskYrwh8ErwXN8iqicaHTP7yQfYS')
const MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

const mintData = (decimals: number) => {
  const data = new Uint8Array(82)
  data[44] = decimals
  return data
}
const tokenData = (amount: bigint) => {
  const data = new Uint8Array(165)
  new DataView(data.buffer).setBigUint64(64, amount, true)
  return data
}
const entry = (data: Uint8Array) => ({
  data: [getBase64Decoder().decode(data), 'base64'],
  executable: false,
  lamports: 1n,
  owner: TOKEN_PROGRAM,
  space: BigInt(data.length),
})
const rpc = (accounts: Record<string, Uint8Array | undefined>) =>
  ({
    getMultipleAccounts: (addresses: string[]) => ({
      send: async () => ({
        context: { slot: 1n },
        value: addresses.map((a) => (accounts[a] ? entry(accounts[a]) : null)),
      }),
    }),
  }) as never

describe('funding account', () => {
  it('reads the wallet’s associated token account of the mint', async () => {
    const account = await associatedTokenAddress(WALLET, MINT, TOKEN_PROGRAM)
    const funding = await readFunding(rpc({ [MINT]: mintData(6), [account]: tokenData(7_500_000n) }), WALLET, MINT)
    expect(funding).toEqual({ mint: MINT, tokenProgram: TOKEN_PROGRAM, account, decimals: 6, balance: 7_500_000n })
  })

  it('has a zero balance for a wallet without the token account', async () => {
    const funding = await readFunding(rpc({ [MINT]: mintData(6) }), WALLET, MINT)
    expect(funding).toMatchObject({ decimals: 6, balance: 0n })
  })

  it('fails when the mint does not exist on the cluster', async () => {
    await expect(readFunding(rpc({}), WALLET, MINT)).rejects.toThrow(
      'The funding token does not exist on this network.',
    )
  })
})
