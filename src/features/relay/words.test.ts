import { x25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js'
import { describe, expect, it, vi } from 'vitest'
import { DEVNET_GENESIS_HASH } from '../../protocol'
import { sealToGateway } from '../../protocol/hpke'
import { encodeCommitment, wordProof, wordRoot, type Commitment } from '../../protocol/payword'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import {
  askFor,
  BATCH_WAIT,
  dueBatch,
  type HeldWord,
  packTransactions,
  pollWords,
  receiveWord,
  submitDue,
  transactionBytes,
  WORD_AAD,
} from './words'

const store = async () => {
  const db = createNodeDb()
  await migrate(db)
  return db
}

const channel = (n: number, expiry = 5_000_000): { commitment: Commitment; seed: Uint8Array } => {
  const seed = new Uint8Array(32).fill(n)
  return {
    seed,
    commitment: {
      mint: new Uint8Array(32).fill(4),
      lockSeq: 0,
      cumEnd: 8_000_000n * BigInt(n),
      depth: 4,
      wordValue: 500_000n,
      root: wordRoot(seed, 4),
      expiry,
    },
  }
}

/** What the gateway seals to a relayer's key for the word `index` of the channel. */
async function envelope(c: ReturnType<typeof channel>, index: number, rk: Uint8Array, tamper = false) {
  const proof = wordProof(c.seed, 4, index)
  if (tamper) proof[40] ^= 1
  const plain = new Uint8Array(512)
  plain.set(concatBytes(encodeCommitment(c.commitment), new Uint8Array(64).fill(3), proof))
  const sealed = await sealToGateway(
    { keyId: 0, publicKey: x25519.getPublicKey(rk) },
    'word',
    DEVNET_GENESIS_HASH,
    plain,
    WORD_AAD,
  )
  return concatBytes(sealed.enc, sealed.ciphertext)
}

const rkSecret = new Uint8Array(32).fill(9)

describe('relayer words', () => {
  it('keeps only a word that opens and verifies against its commitment', async () => {
    const db = await store()
    const c = channel(1)
    await expect(
      receiveWord(db, await envelope(c, 0, rkSecret, true), rkSecret, DEVNET_GENESIS_HASH, 10),
    ).rejects.toThrow('word does not verify')
    await expect(
      receiveWord(db, await envelope(c, 0, rkSecret), new Uint8Array(32).fill(8), DEVNET_GENESIS_HASH, 10),
    ).rejects.toThrow('word does not open')
    const word = await receiveWord(db, await envelope(c, 3, rkSecret), rkSecret, DEVNET_GENESIS_HASH, 10)
    expect(word).toMatchObject({ index: 3, state: 'held', expiry: 5_000_000 })
    expect(await db.all('SELECT idx FROM relay_words')).toEqual([{ idx: 3 }])
  })

  it('settles at eight held words or when the oldest is twelve hours old, and an odd word waits', async () => {
    const db = await store()
    const a = channel(1)
    await receiveWord(db, await envelope(a, 0, rkSecret), rkSecret, DEVNET_GENESIS_HASH, 100)
    expect((await dueBatch(db, { now: 100 + BATCH_WAIT, batchMin: 8 })).words).toHaveLength(0)
    const b = channel(2, 6_000_000)
    await receiveWord(db, await envelope(b, 0, rkSecret), rkSecret, DEVNET_GENESIS_HASH, 200)
    expect((await dueBatch(db, { now: 99 + BATCH_WAIT, batchMin: 8 })).words).toHaveLength(0)
    const due = await dueBatch(db, { now: 100 + BATCH_WAIT, batchMin: 8 })
    expect(due.words).toHaveLength(2)
    expect(due.exps).toEqual([1])
    await receiveWord(db, await envelope(b, 1, rkSecret), rkSecret, DEVNET_GENESIS_HASH, 300)
    const odd = await dueBatch(db, { now: 100 + BATCH_WAIT, batchMin: 8 })
    expect(odd.words).toHaveLength(2)
    expect(odd.words.every((word) => word.expiry === 5_000_000 || word.index < 2)).toBe(true)
    expect(odd.words.map((word) => word.expiry)).not.toContain(6_000_000 + 1)
  })

  it('holds back the word whose window closes last when the count is odd', async () => {
    const db = await store()
    const early = channel(1, 5_000_000)
    const late = channel(2, 6_000_000)
    await receiveWord(db, await envelope(early, 0, rkSecret), rkSecret, DEVNET_GENESIS_HASH, 1)
    await receiveWord(db, await envelope(early, 1, rkSecret), rkSecret, DEVNET_GENESIS_HASH, 1)
    await receiveWord(db, await envelope(late, 0, rkSecret), rkSecret, DEVNET_GENESIS_HASH, 1)
    const due = await dueBatch(db, { now: 1 + BATCH_WAIT })
    expect(due.words.map((word) => word.expiry)).toEqual([5_000_000, 5_000_000])
  })

  it('packs at most three channels, an even number of words and the bytes of one transaction', () => {
    const word = (channelId: number, index: number): HeldWord => ({
      channel: new Uint8Array(32).fill(channelId),
      index,
      commitment: new Uint8Array(91),
      signature: new Uint8Array(64),
      proof: new Uint8Array(34 + 32 * 4),
      expiry: 1,
      receivedAt: 1,
      state: 'held',
    })
    const words = [1, 2, 3, 4].flatMap((id) => [0, 1, 2, 3].map((index) => word(id, index)))
    const groups = packTransactions(words)
    expect(groups.map((group) => group.length)).toEqual([12, 4])
    for (const group of groups) {
      expect(group.length % 2).toBe(0)
      expect(new Set(group.map((w) => bytesToHex(w.channel))).size).toBeLessThanOrEqual(3)
      expect(
        transactionBytes(
          new Set(group.map((w) => bytesToHex(w.channel))).size,
          group.map(() => 4),
        ),
      ).toBeLessThanOrEqual(4_096)
    }
    expect(packTransactions([word(1, 0), word(2, 0), word(3, 0)]).flat()).toHaveLength(2)
  })

  it('models the transaction sizes measured on the program', () => {
    expect(transactionBytes(1, [4, 4])).toBe(1_370)
    expect(transactionBytes(1, Array(16).fill(4))).toBe(3_694)
    expect(transactionBytes(2, Array(8).fill(4))).toBe(2_838)
    expect(transactionBytes(4, Array(16).fill(4))).toBe(5_110)
    expect(transactionBytes(1, Array(8).fill(8))).toBe(3_390)
  })

  it('settles the due words with one inner per exponent and no secret in the request', async () => {
    const db = await store()
    for (const [n, index] of [
      [1, 0],
      [1, 1],
      [2, 0],
      [2, 1],
      [3, 0],
      [3, 1],
    ])
      await receiveWord(db, await envelope(channel(n), index, rkSecret), rkSecret, DEVNET_GENESIS_HASH, 1)
    const exps: number[] = []
    const post = vi.fn(async (_body: unknown) => ({ status: 'submitted' as const, jobKey: 'k' }))
    const submitted = await submitDue(db, {
      now: 1 + BATCH_WAIT,
      makeInner: async (exp) => {
        exps.push(exp)
        return new Uint8Array(32).fill(exp)
      },
      post,
    })
    expect(submitted).toBe(6)
    expect(exps).toEqual([2, 1])
    const request = post.mock.calls[0][0] as { channels: { words: string[] }[]; inners: string[] }
    expect(request.channels.map((c) => c.words.length)).toEqual([2, 2, 2])
    expect(request.inners).toHaveLength(2)
    expect(await db.all("SELECT idx FROM relay_words WHERE state = 'submitted'")).toHaveLength(6)
  })

  it('marks words the gateway refuses as rejected and leaves a retry for later', async () => {
    const db = await store()
    for (const index of [0, 1])
      await receiveWord(db, await envelope(channel(1), index, rkSecret), rkSecret, DEVNET_GENESIS_HASH, 1)
    const run = (status: 'refused' | 'retry') =>
      submitDue(db, {
        now: 1 + BATCH_WAIT,
        makeInner: async () => new Uint8Array(32),
        post: async () => ({ status }),
      })
    await run('retry')
    expect(await db.all("SELECT idx FROM relay_words WHERE state = 'held'")).toHaveLength(2)
    await run('refused')
    expect(await db.all("SELECT idx FROM relay_words WHERE state = 'rejected'")).toHaveLength(2)
  })

  it('asks for a word with a key of its own and keeps the secret only until the word is there', async () => {
    const db = await store()
    const id = sha256(new Uint8Array([1]))
    const rk = await askFor(db, id, 100)
    expect(rk).toHaveLength(32)
    const [ask] = await db.all<{ rk_secret: Uint8Array }>('SELECT rk_secret FROM relay_word_asks')
    expect(x25519.getPublicKey(ask.rk_secret)).toEqual(rk)
    const c = channel(1)
    const sealed = await envelope(c, 2, ask.rk_secret)
    const fetchWord = vi.fn(async () => ({ status: 200 as const, body: sealed }))
    expect(await pollWords(db, fetchWord, DEVNET_GENESIS_HASH, 105)).toBe(1)
    expect(await db.all('SELECT id FROM relay_word_asks')).toEqual([])
    expect(await db.all('SELECT idx FROM relay_words')).toEqual([{ idx: 2 }])
  })

  it('polls again later on a 404, stops on a 410 and gives up after a day', async () => {
    const db = await store()
    const id = sha256(new Uint8Array([2]))
    await askFor(db, id, 100)
    const waiting = vi.fn(async () => ({ status: 404 as const }))
    expect(await pollWords(db, waiting, DEVNET_GENESIS_HASH, 104)).toBe(0)
    expect(waiting).not.toHaveBeenCalled()
    await pollWords(db, waiting, DEVNET_GENESIS_HASH, 105)
    const [{ next_poll_at }] = await db.all<{ next_poll_at: number }>('SELECT next_poll_at FROM relay_word_asks')
    expect(next_poll_at).toBeGreaterThan(110)
    await pollWords(db, waiting, DEVNET_GENESIS_HASH, 100 + 86_400)
    expect(await db.all('SELECT id FROM relay_word_asks')).toEqual([])
    await askFor(db, id, 200)
    await pollWords(db, async () => ({ status: 410 }), DEVNET_GENESIS_HASH, 205)
    expect(await db.all('SELECT id FROM relay_word_asks')).toEqual([])
  })

  it('reports a word that cannot be fetched, keeping the ask, and one that does not verify, dropping it', async () => {
    const db = await store()
    const id = sha256(new Uint8Array([3]))
    await askFor(db, id, 100)
    const unreachable = vi.fn(async () => Promise.reject(new Error('The gateway answered 502.')))
    await expect(pollWords(db, unreachable, DEVNET_GENESIS_HASH, 105)).rejects.toThrow(
      'could not be fetched: The gateway answered 502.',
    )
    expect(await db.all('SELECT id FROM relay_word_asks')).toHaveLength(1)
    const garbage = vi.fn(async () => ({ status: 200 as const, body: new Uint8Array(40) }))
    await expect(pollWords(db, garbage, DEVNET_GENESIS_HASH, 10_000)).rejects.toThrow('A word did not open or verify')
    expect(await db.all('SELECT id FROM relay_word_asks')).toEqual([])
  })
})
