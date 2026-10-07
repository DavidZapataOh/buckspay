import { ed25519 } from '@noble/curves/ed25519.js'
import {
  type Address,
  type Blockhash,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit'
import { describe, expect, it, vi } from 'vitest'
import type { JobAnswer } from './api'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { type MoveDeps, moveRewards } from './move'
import { makeLeafSecret } from './secrets'

const WALLET = '11111111111111111111111111111112' as Address
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address
const GATEWAY = 'SysvarRent111111111111111111111111111111111' as Address
const FEE_ACCOUNT = 'SysvarC1ock11111111111111111111111111111111' as Address
const NOW = 1_800_000_000

async function setup(balances: bigint[], options: { destinationHasAccount?: boolean; answer?: JobAnswer } = {}) {
  const db = createNodeDb()
  await migrate(db)
  for (const [i] of balances.entries()) {
    const seed = new Uint8Array(32).fill(i + 1)
    const secret = await makeLeafSecret(db, 1, NOW)
    await db.run("UPDATE leaf_secrets SET state = 'claimed', recipient = ?, recipient_secret = ? WHERE leaf = ?", [
      ed25519.getPublicKey(seed),
      seed,
      secret.leaf,
    ])
  }
  const balance = vi.fn(async () => balances.shift() ?? 0n)
  const submitSweep = vi.fn(
    async (_transaction: string): Promise<JobAnswer> => options.answer ?? { status: 'settled', signature: 'sig' },
  )
  const claimStatus = vi.fn(async (): Promise<JobAnswer> => ({ status: 'settled', signature: 'sig' }))
  const deps: MoveDeps = {
    db,
    destination: WALLET,
    mint: MINT,
    decimals: 6,
    chain: {
      balance,
      hasTokenAccount: async () => options.destinationHasAccount ?? true,
      blockhash: async () => ({
        blockhash: '11111111111111111111111111111111' as Blockhash,
        lastValidBlockHeight: 10n,
      }),
    },
    quote: async () => ({
      gateway: GATEWAY,
      feeAccount: FEE_ACCOUNT,
      fee: 20_000n,
      feeWithAccount: 2_100_000n,
      computeUnitLimit: 40_000,
      computeUnitPrice: 10_000n,
    }),
    gateway: { submitSweep, claimStatus },
    sleep: async () => {},
  }
  return { deps, submitSweep, claimStatus, balance }
}

const instructionsOf = (transaction: string) => {
  const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(transaction))
  const compiled = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes)
  return {
    count: 'instructions' in compiled ? compiled.instructions.length : -1,
    signatures: Object.values(decoded.signatures),
  }
}

describe('moving the rewards', () => {
  it('sweeps each claimed address that holds a balance, signed by the fresh address alone', async () => {
    const { deps, submitSweep } = await setup([1_000_000n, 0n, 980_000n])
    expect(await moveRewards(deps)).toEqual({ moved: 2, amount: 1_000_000n - 20_000n + 980_000n - 20_000n })
    expect(submitSweep).toHaveBeenCalledTimes(2)
    const sent = instructionsOf(submitSweep.mock.calls[0][0])
    expect(sent.count).toBe(4)
    expect(sent.signatures.filter((signature) => signature !== null)).toHaveLength(1)
  })

  it('asks the sweep to create the wallet token account, and pays the larger fee, when it is missing', async () => {
    const { deps, submitSweep } = await setup([3_000_000n], { destinationHasAccount: false })
    expect(await moveRewards(deps)).toEqual({ moved: 1, amount: 900_000n })
    expect(instructionsOf(submitSweep.mock.calls[0][0]).count).toBe(5)
  })

  it('leaves dust that does not cover the fee where it is', async () => {
    const { deps, submitSweep } = await setup([20_000n])
    await expect(moveRewards(deps)).rejects.toThrow('Nothing to move yet.')
    expect(submitSweep).not.toHaveBeenCalled()
  })

  it('says nothing is waiting when no address holds a balance', async () => {
    const { deps } = await setup([0n])
    await expect(moveRewards(deps)).rejects.toThrow('Nothing to move yet.')
  })

  it('waits for a sweep the gateway accepted until it settles', async () => {
    const { deps, claimStatus } = await setup([1_000_000n], { answer: { status: 'submitted', jobKey: 'job' } })
    claimStatus
      .mockResolvedValueOnce({ status: 'submitted' })
      .mockResolvedValueOnce({ status: 'settled', signature: 's' })
    expect((await moveRewards(deps)).moved).toBe(1)
    expect(claimStatus).toHaveBeenCalledTimes(2)
  })

  it('reports a refused sweep with its reason, after trying the others', async () => {
    const { deps, submitSweep } = await setup([1_000_000n, 1_000_000n])
    submitSweep.mockResolvedValueOnce({ status: 'refused', reason: 'fee' })
    await expect(moveRewards(deps)).rejects.toThrow(/fee/)
    expect(submitSweep).toHaveBeenCalledTimes(2)
  })

  it('reports a retry the gateway asks for', async () => {
    const { deps } = await setup([1_000_000n], { answer: { status: 'retry', retryAfter: 600 } })
    await expect(moveRewards(deps)).rejects.toThrow(/try again/i)
  })
})
