import { describe, expect, it } from 'vitest'
import { encodeCommitment, wordRoot } from '../../protocol/payword'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { rewardRecords, wordRecords } from './records'

const commitment = (wordValue: bigint) =>
  encodeCommitment({
    mint: new Uint8Array(32).fill(4),
    lockSeq: 0,
    cumEnd: 8_000_000n,
    depth: 4,
    wordValue,
    root: wordRoot(new Uint8Array(32).fill(1), 4),
    expiry: 5_000_000,
  })

async function store() {
  const db = createNodeDb()
  await migrate(db)
  const add = (idx: number, state: string, value: bigint, receivedAt: number) =>
    db.run(
      'INSERT INTO relay_words (channel, idx, commitment, signature, proof, expiry, received_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        new Uint8Array(32).fill(1),
        idx,
        commitment(value),
        new Uint8Array(64),
        new Uint8Array(0),
        5_000_000,
        receivedAt,
        state,
      ],
    )
  return { db, add }
}

describe('reward records', () => {
  it('reads the held words with the fee of their commitment, newest first', async () => {
    const { db, add } = await store()
    await add(0, 'held', 500_000n, 10)
    await add(1, 'rejected', 490_000n, 20)
    expect(await wordRecords(db)).toEqual([
      { kind: 'word', state: 'rejected', value: 490_000n },
      { kind: 'word', state: 'held', value: 500_000n },
    ])
  })

  it('adds the leaves of the claim store when there is one', async () => {
    const { db, add } = await store()
    await add(0, 'held', 500_000n, 10)
    const leaf = { kind: 'leaf', state: 'unclaimed', exp: 0, unit: 1n } as const
    expect(await rewardRecords(db, async () => [leaf])).toHaveLength(2)
    expect(await rewardRecords(db)).toHaveLength(1)
  })
})
