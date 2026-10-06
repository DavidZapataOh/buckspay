import { type Address, address } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { associatedTokenAddress } from '../lock/operations'
import { createTokenAccountInstruction } from './create-token-account'
import { TOKEN_PROGRAM } from './token-account'

const wallet = address('11111111111111111111111111111112')
const mint = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')

describe('creating the USDC account of the wallet', () => {
  it('is the idempotent create of the associated token program, paid and signed by the wallet itself', async () => {
    const payer = { address: wallet } as never
    const instruction = await createTokenAccountInstruction(payer, wallet, mint, TOKEN_PROGRAM)
    expect(instruction.programAddress).toBe('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
    expect([...(instruction.data ?? [])]).toEqual([1])
    const accounts = (instruction.accounts ?? []).map((account) => account.address as Address)
    expect(accounts).toEqual([
      wallet,
      await associatedTokenAddress(wallet, mint, TOKEN_PROGRAM),
      wallet,
      mint,
      '11111111111111111111111111111111',
      TOKEN_PROGRAM,
    ])
  })
})
