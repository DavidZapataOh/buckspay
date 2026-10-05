import { findLockPda, getLedgerEncoder, getLockEncoder } from '@project/anchor'
import { type Address, address, getBase58Decoder, getBase64Decoder } from '@solana/kit'
import { describe, expect, it, vi } from 'vitest'
import { resolveProfile } from '../../protocol'
import { isWithdrawable, readLocks, withdrawalOpensAt } from './locks'

const PROGRAM = address(resolveProfile({}).programId)
const { windows } = resolveProfile({})
const MINT = address('7LSfLv2S5Gj1Zbbw6rwMsE7Dz7F4tJxQ3ZyKfd9mS6P8')
const PAYER = address('2t2uAzmx5tbSdU2MRZ6XU3i6D9bCqPb7S5tQe6Z2uJ8y')
const key = Uint8Array.from([2, ...Array.from({ length: 32 }, (_, i) => i + 1)])
const base64 = (bytes: Uint8Array) => [getBase64Decoder().decode(bytes), 'base64'] as const

async function chain(locks: { lockSeq: number; lockUntil: number; withdrawn?: boolean }[]) {
  const ledgers: { pubkey: Address; account: { data: readonly [string, 'base64'] } }[] = []
  const accounts = new Map<Address, Uint8Array>()
  for (const { lockSeq, lockUntil, withdrawn = false } of locks) {
    const [lock] = await findLockPda(key, lockSeq, PROGRAM)
    accounts.set(
      lock,
      Uint8Array.from(
        getLockEncoder().encode({ mint: MINT, bond: 2_000_000n, backing: 3_000_000n, lockUntil, bump: 255 }),
      ),
    )
    ledgers.push({
      pubkey: PAYER,
      account: {
        data: base64(
          Uint8Array.from(
            getLedgerEncoder().encode({
              backingLeft: 2_500_000n,
              bondFree: 1_500_000n,
              bondSlashed: 500_000n,
              payer: PAYER,
              key,
              lockSeq,
              withdrawn,
              bump: 254,
            }),
          ),
        ),
      },
    })
  }
  const getProgramAccounts = vi.fn(() => ({ send: async () => ledgers }))
  const getMultipleAccounts = vi.fn((addresses: Address[]) => ({
    send: async () => ({
      context: { slot: 1n },
      value: addresses.map((a) => {
        const data = accounts.get(a)
        return data
          ? { data: base64(data), executable: false, lamports: 1n, owner: PROGRAM, space: BigInt(data.length) }
          : null
      }),
    }),
  }))
  return { getProgramAccounts, getMultipleAccounts } as never
}

describe('lock list', () => {
  it('uses the ledger key filter', async () => {
    const rpc = await chain([{ lockSeq: 0, lockUntil: 1_900_000_000 }])
    await readLocks(rpc, PROGRAM, key)
    const [program, config] = (rpc as { getProgramAccounts: ReturnType<typeof vi.fn> }).getProgramAccounts.mock.calls[0]
    expect(program).toBe(PROGRAM)
    expect(config.filters).toEqual([
      { dataSize: 103n },
      { memcmp: { offset: 64n, bytes: getBase58Decoder().decode(key), encoding: 'base58' } },
    ])
  })

  it('lists the key’s locks by number with what each holds', async () => {
    const rpc = await chain([
      { lockSeq: 1, lockUntil: 1_900_000_100 },
      { lockSeq: 0, lockUntil: 1_900_000_000, withdrawn: true },
    ])
    const locks = await readLocks(rpc, PROGRAM, key)
    expect(locks.map((l) => l.lockSeq)).toEqual([0, 1])
    expect(locks[1]).toMatchObject({
      mint: MINT,
      backingLeft: 2_500_000n,
      bondFree: 1_500_000n,
      bondSlashed: 500_000n,
      lockUntil: 1_900_000_100,
      payer: PAYER,
      withdrawn: false,
    })
  })

  it('has no locks for a key without ledgers', async () => {
    expect(await readLocks(await chain([]), PROGRAM, key)).toEqual([])
  })
})

describe('withdrawal date', () => {
  const lock = { lockUntil: 1_900_000_000, withdrawn: false }
  it('opens a claim window after the lock ends', () => {
    expect(withdrawalOpensAt(lock, windows)).toBe(1_900_000_000 + windows.claimWindow)
  })
  it('shows the withdraw button only after the window', () => {
    const opens = withdrawalOpensAt(lock, windows)
    expect(isWithdrawable(lock, windows, opens - 1)).toBe(false)
    expect(isWithdrawable(lock, windows, opens)).toBe(true)
    expect(isWithdrawable({ ...lock, withdrawn: true }, windows, opens + 1)).toBe(false)
  })
})
