import { describe, expect, it } from 'vitest'
import { wordProof } from '../../protocol/payword'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { CHANNEL_SECONDS, nextWord, ROTATE_BEFORE, type TipLock, tipFor, type TipOptions } from './tip'

const store = async () => {
  const db = createNodeDb()
  await migrate(db)
  return db
}

const lock = (change: Partial<TipLock> = {}): TipLock => ({
  device: new Uint8Array(33).fill(2),
  mint: new Uint8Array(32).fill(4),
  lockSeq: 0,
  bond: 40_000_000n,
  backing: 100_000_000n,
  lockUntil: 10_000_000,
  ...change,
})

let seeds = 0
const options = (now: number, change: Partial<TipOptions> = {}): TipOptions => ({
  wordValue: 500_000n,
  sign: async () => new Uint8Array(64).fill(7),
  now,
  random: () => new Uint8Array(32).fill(++seeds),
  ...change,
})

const cursor = async (db: Awaited<ReturnType<typeof store>>) =>
  (await db.all<{ next_cum_end: number }>('SELECT next_cum_end FROM lock_cursor'))[0]?.next_cum_end

describe('payer tip channels', () => {
  it('writes next_index before building the proof and never reuses it after a crash', async () => {
    const db = await store()
    const crash = (): Uint8Array => {
      throw new Error('crash while building')
    }
    await expect(nextWord(db, lock(), options(1_000), crash)).rejects.toThrow('crash')
    const [row] = await db.all<{ next_index: number }>('SELECT next_index FROM payword_channels')
    expect(row.next_index).toBe(1)
    const second = await nextWord(db, lock(), options(1_000))
    expect(second).toMatchObject({ index: 1 })
  })

  it('opens a new channel when its words run out and when it expires within an hour', async () => {
    const db = await store()
    const first = await tipFor(db, lock(), options(1_000))
    if ('off' in first) throw new Error('tipping is off')
    for (let i = 0; i < 16; i++) await nextWord(db, lock(), options(1_000))
    const afterWords = await tipFor(db, lock(), options(1_000))
    if ('off' in afterWords) throw new Error('tipping is off')
    expect(afterWords.hash).not.toEqual(first.hash)
    const nearEnd = await tipFor(db, lock(), options(1_000 + CHANNEL_SECONDS - ROTATE_BEFORE))
    if ('off' in nearEnd) throw new Error('tipping is off')
    expect(nearEnd.hash).not.toEqual(afterWords.hash)
  })

  it('uses a fresh seed for every channel and reserves a new interval for each', async () => {
    const db = await store()
    const a = await tipFor(db, lock(), options(1_000))
    for (let i = 0; i < 16; i++) await nextWord(db, lock(), options(1_000))
    const b = await tipFor(db, lock(), options(1_000))
    if ('off' in a || 'off' in b) throw new Error('tipping is off')
    expect(a.seed).not.toEqual(b.seed)
    expect(a.commitment.root).not.toEqual(b.commitment.root)
    expect(b.commitment.cumEnd - a.commitment.cumEnd).toBe(8_000_000n)
    expect(await cursor(db)).toBe(16_000_000)
  })

  it('serves words whose proofs the commitment verifies, in order', async () => {
    const db = await store()
    const first = await nextWord(db, lock(), options(1_000))
    const second = await nextWord(db, lock(), options(1_000))
    if ('off' in first || 'off' in second) throw new Error('tipping is off')
    expect([first.index, second.index]).toEqual([0, 1])
    const tip = await tipFor(db, lock(), options(1_000))
    if ('off' in tip) throw new Error('tipping is off')
    const proof = wordProof(tip.seed, tip.commitment.depth, 1)
    expect(second.word.subarray(91 + 64 + 2)).toEqual(proof)
  })

  it('says why it cannot tip and reserves nothing then', async () => {
    const db = await store()
    expect(await tipFor(db, lock({ bond: 31_999_999n }), options(1_000))).toEqual({ off: 'bond' })
    expect(await tipFor(db, lock({ backing: 7_999_999n }), options(1_000))).toEqual({ off: 'room' })
    expect(await tipFor(db, lock({ lockUntil: 1_000 + ROTATE_BEFORE }), options(1_000))).toEqual({ off: 'lock_ends' })
    expect(await db.all('SELECT * FROM payword_channels')).toEqual([])
    expect(await cursor(db)).toBeUndefined()
  })

  it('stores the seed before signing and signs a stored channel once without reserving again', async () => {
    const db = await store()
    let stored = 0
    const sign = async () => {
      stored = (await db.all('SELECT * FROM payword_channels WHERE signature IS NULL')).length
      throw new Error('the signer failed')
    }
    await expect(tipFor(db, lock(), options(1_000, { sign }))).rejects.toThrow('signer')
    expect(stored).toBe(1)
    const reserved = await cursor(db)
    const tip = await tipFor(db, lock(), options(1_000))
    if ('off' in tip) throw new Error('tipping is off')
    expect(tip.signature).toEqual(new Uint8Array(64).fill(7))
    expect(await cursor(db)).toBe(reserved)
    expect(await db.all('SELECT hash FROM payword_channels')).toHaveLength(1)
  })
})
