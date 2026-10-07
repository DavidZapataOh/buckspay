import {
  type Commitment,
  commitmentHash,
  commitmentTotal,
  encodeCommitment,
  MIN_WORD_DEPTH,
  paywordEnvelope,
  wordProof,
  wordRoot,
} from '../../protocol/payword'
import type { NoteDb } from '../notes/db'
import { encodeWord } from './inner'

/** Seconds a channel lives: its words settle until then and the grace period after it. */
export const CHANNEL_SECONDS = 72 * 3_600
/** A channel that expires within this many seconds is not used for another word. */
export const ROTATE_BEFORE = 3_600

/** What the payer's lock offers a channel. */
export type TipLock = {
  device: Uint8Array
  mint: Uint8Array
  lockSeq: number
  bond: bigint
  backing: bigint
  lockUntil: number
}

export type TipOptions = {
  wordValue: bigint
  /** The envelope domain of the cluster: `domain(Purpose.PayWord, genesisHash, programId)`. */
  domain: Uint8Array
  /** The device key's signature over an envelope (`signPayword`). */
  sign: (envelope: Uint8Array) => Promise<Uint8Array>
  now: number
  depth?: number
  random?: () => Uint8Array
}

/** Why a payment cannot tip: the lock's bond does not cover a channel, its backing has no room for one, or it ends too soon. */
export type TipOff = { off: 'bond' | 'room' | 'lock_ends' }

export type Tip = { hash: Uint8Array; commitment: Commitment; signature: Uint8Array; seed: Uint8Array }

type Stored = {
  hash: Uint8Array
  mint: Uint8Array
  lock_seq: number
  cum_end: number
  depth: number
  word_value: number
  expiry: number
  seed: Uint8Array
  signature: Uint8Array | null
}

const randomSeed = () => crypto.getRandomValues(new Uint8Array(32))

const toTip = (row: Stored, root: Uint8Array): Omit<Tip, 'signature'> & { signature: Uint8Array | null } => ({
  hash: row.hash,
  seed: row.seed,
  signature: row.signature,
  commitment: {
    mint: row.mint,
    lockSeq: row.lock_seq,
    cumEnd: BigInt(row.cum_end),
    depth: row.depth,
    wordValue: BigInt(row.word_value),
    root,
    expiry: row.expiry,
  },
})

/**
 * The channel the next word comes from. It is a channel of this lock with words left that does not expire within an hour;
 * when there is none, a new one is opened: its interval is reserved by moving the lock's cursor, a fresh seed is stored
 * before anything is signed, and only then is the commitment signed.
 */
export async function tipFor(db: NoteDb, lock: TipLock, options: TipOptions): Promise<Tip | TipOff> {
  const { now } = options
  const [live] = await db.all<Stored>(
    `SELECT * FROM payword_channels WHERE device = ? AND lock_seq = ? AND next_index < (1 << depth) AND expiry > ?
     ORDER BY created_at DESC LIMIT 1`,
    [lock.device, lock.lockSeq, now + ROTATE_BEFORE],
  )
  const row = live ?? (await open(db, lock, options))
  if (!('hash' in row)) return row
  const { signature, ...tip } = toTip(row, wordRoot(row.seed, row.depth))
  if (signature) return { ...tip, signature }
  const signed = await options.sign(paywordEnvelope(options.domain, tip.commitment))
  await db.run('UPDATE payword_channels SET signature = ? WHERE hash = ? AND signature IS NULL', [signed, row.hash])
  return { ...tip, signature: signed }
}

async function open(db: NoteDb, lock: TipLock, options: TipOptions): Promise<Stored | TipOff> {
  const depth = options.depth ?? MIN_WORD_DEPTH
  const expiry = Math.min(options.now + CHANNEL_SECONDS, lock.lockUntil)
  if (expiry - options.now <= ROTATE_BEFORE) return { off: 'lock_ends' }
  const draft: Commitment = {
    mint: lock.mint,
    lockSeq: lock.lockSeq,
    cumEnd: 0n,
    depth,
    wordValue: options.wordValue,
    root: new Uint8Array(32),
    expiry,
  }
  const total = commitmentTotal(draft)
  if (total === null || lock.bond < 4n * total) return { off: 'bond' }
  const seed = (options.random ?? randomSeed)()
  const root = wordRoot(seed, depth)
  return db.transaction(async (tx) => {
    const [cursor] = await tx.all<{ next_cum_end: number }>(
      'SELECT next_cum_end FROM lock_cursor WHERE device = ? AND lock_seq = ?',
      [lock.device, lock.lockSeq],
    )
    const start = BigInt(cursor?.next_cum_end ?? 0)
    if (lock.backing - start < total) return { off: 'room' as const }
    const commitment = { ...draft, cumEnd: start + total, root }
    const hash = commitmentHash(commitment)
    await tx.run(
      'INSERT INTO lock_cursor (device, lock_seq, next_cum_end) VALUES (?, ?, ?) ON CONFLICT (device, lock_seq) DO UPDATE SET next_cum_end = excluded.next_cum_end',
      [lock.device, lock.lockSeq, Number(commitment.cumEnd)],
    )
    await tx.run(
      `INSERT INTO payword_channels (hash, device, lock_seq, mint, cum_end, depth, word_value, expiry, seed, signature, next_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
      [
        hash,
        lock.device,
        lock.lockSeq,
        lock.mint,
        Number(commitment.cumEnd),
        depth,
        Number(options.wordValue),
        expiry,
        seed,
        options.now,
      ],
    )
    const [stored] = await tx.all<Stored>('SELECT * FROM payword_channels WHERE hash = ?', [hash])
    return stored
  })
}

/** A word for the inner message of one payment: `commitment ‖ sig ‖ len ‖ proof`, ready for `encodeInner`. */
export type TipWord = { hash: Uint8Array; index: number; word: Uint8Array }

/**
 * The next word of the lock's channel. The channel's next index moves in the database before the proof is built: a crash
 * after it spends that index and the next payment takes the one after, so two blobs never carry the same word.
 */
export async function nextWord(
  db: NoteDb,
  lock: TipLock,
  options: TipOptions,
  build: typeof wordProof = wordProof,
): Promise<TipWord | TipOff> {
  for (;;) {
    const tip = await tipFor(db, lock, options)
    if ('off' in tip) return tip
    const index = await db.transaction(async (tx) => {
      const [row] = await tx.all<{ next_index: number }>(
        'SELECT next_index FROM payword_channels WHERE hash = ? AND next_index < (1 << depth)',
        [tip.hash],
      )
      if (!row) return null
      await tx.run('UPDATE payword_channels SET next_index = next_index + 1 WHERE hash = ?', [tip.hash])
      return row.next_index
    })
    if (index === null) continue
    const proof = build(tip.seed, tip.commitment.depth, index)
    return { hash: tip.hash, index, word: encodeWord(encodeCommitment(tip.commitment), tip.signature, proof) }
  }
}
