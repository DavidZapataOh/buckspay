import { describe, expect, it, vi } from 'vitest'
import type { OfflineLock } from '../../payment/preflight'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { tipWord } from './tip-word'

const NOW = 1_800_000_000
const lock = (bond: bigint, lockSeq = 0): OfflineLock =>
  ({
    lockSeq,
    mint: new Uint8Array(32).fill(4),
    bond,
    backing: 500_000_000n,
    lockUntil: NOW + 30 * 86_400,
    nextCumEnd: 0n,
    ticket: { device: new Uint8Array(33).fill(2) },
  }) as unknown as OfflineLock

const issueOf = (lockSeq: number) => ({ message: { lockSeq } }) as never

async function setup(locks: OfflineLock[]) {
  const db = createNodeDb()
  await migrate(db)
  const sign = vi.fn(async () => new Uint8Array(64).fill(7))
  const word = tipWord({
    db,
    locks,
    wordValue: 500_000n,
    sign,
    now: () => NOW,
  })
  return { word, sign }
}

describe('the word of a tip', () => {
  it('gives the next word of the payment lock, signing the channel once', async () => {
    const { word, sign } = await setup([lock(40_000_000n)])
    const first = await word(issueOf(0))
    const second = await word(issueOf(0))
    expect(first).toBeInstanceOf(Uint8Array)
    expect(second).not.toEqual(first)
    expect(sign).toHaveBeenCalledOnce()
  })

  it('pays no tip, and says so with null, when the lock cannot cover a channel', async () => {
    const { word, sign } = await setup([lock(1_000_000n)])
    expect(await word(issueOf(0))).toBeNull()
    expect(sign).not.toHaveBeenCalled()
  })

  it('pays no tip for a lock this phone has no ticket for', async () => {
    const { word } = await setup([lock(40_000_000n, 1)])
    expect(await word(issueOf(0))).toBeNull()
  })
})
