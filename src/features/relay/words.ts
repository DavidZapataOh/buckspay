import { x25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { openSealed } from '../../protocol/hpke'
import { canonicalExps, decodeCommitment, MAX_WORDS_PER_TX, verifyWord, type Commitment } from '../../protocol/payword'
import type { NoteDb } from '../notes/db'

/** Words held before a relayer settles them, and the age after which it settles whatever it has. */
export const BATCH_MIN = 8
export const BATCH_WAIT = 12 * 3_600
/** The most channels one settlement transaction carries, and the size it must fit. */
export const MAX_CHANNELS_PER_TX = 3
export const MAX_TX_BYTES = 4_096
/** Seconds before the first poll for a word, the longest wait between polls and how long a blob is asked about. */
const POLL_FIRST = 5
const POLL_MAX = 600
const ASK_TTL = 86_400

export const WORD_AAD = new TextEncoder().encode('buckspay/word/v1')
const COMMITMENT = 91
const SIGNATURE = 64

export type WordState = 'held' | 'submitted' | 'in_tree' | 'rejected'

export type HeldWord = {
  channel: Uint8Array
  index: number
  commitment: Uint8Array
  signature: Uint8Array
  proof: Uint8Array
  expiry: number
  receivedAt: number
  state: WordState
}

type Stored = Omit<HeldWord, 'receivedAt'> & { received_at: number }

const toWord = ({ received_at, ...word }: Stored): HeldWord => ({ ...word, receivedAt: received_at })

/** A fresh key for the blob `id`: its secret stays here until the word arrives, its public half is posted after the blob. */
export async function askFor(db: NoteDb, id: Uint8Array, now: number): Promise<Uint8Array> {
  const secret = x25519.utils.randomSecretKey()
  await db.run(
    'INSERT OR REPLACE INTO relay_word_asks (id, rk_secret, asked_at, next_poll_at, polls) VALUES (?, ?, ?, ?, 0)',
    [id, secret, now, now + POLL_FIRST],
  )
  return x25519.getPublicKey(secret)
}

/**
 * Opens a word sealed to `rkSecret`, checks that its proof belongs to its commitment and keeps it as held. The
 * relayer cannot check the issuer's signature: the gateway does, and the program does again when the word is settled.
 */
export async function receiveWord(
  db: NoteDb,
  envelope: Uint8Array,
  rkSecret: Uint8Array,
  genesisHash: Uint8Array,
  now: number,
): Promise<HeldWord> {
  const plain = await openSealed(
    rkSecret,
    { enc: envelope.subarray(0, 32), ciphertext: envelope.subarray(32) },
    'word',
    genesisHash,
    WORD_AAD,
  )
  if (!plain || plain.length < COMMITMENT + SIGNATURE) throw new Error('The word does not open.')
  const commitmentBytes = plain.slice(0, COMMITMENT)
  let commitment: Commitment
  try {
    commitment = decodeCommitment(commitmentBytes)
  } catch {
    throw new Error('The word has no commitment.')
  }
  const proofLength = 34 + 32 * commitment.depth
  const proof = plain.slice(COMMITMENT + SIGNATURE, COMMITMENT + SIGNATURE + proofLength)
  if (proof.length !== proofLength || !verifyWord(commitment, proof)) throw new Error('The word does not verify.')
  const word: HeldWord = {
    channel: sha256(commitmentBytes),
    index: (proof[0] << 8) | proof[1],
    commitment: commitmentBytes,
    signature: plain.slice(COMMITMENT, COMMITMENT + SIGNATURE),
    proof,
    expiry: commitment.expiry,
    receivedAt: now,
    state: 'held',
  }
  await db.run(
    `INSERT OR IGNORE INTO relay_words (channel, idx, commitment, signature, proof, expiry, received_at, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'held')`,
    [word.channel, word.index, word.commitment, word.signature, word.proof, word.expiry, now],
  )
  return word
}

export type WordFetch = { status: 200; body: Uint8Array } | { status: 404 | 410 }

/**
 * Asks the gateway for the words of the blobs this phone posted. A word that arrives is kept and its key forgotten; a
 * `410` ends the ask; a `404` is asked again later, up to a day after the post.
 */
export async function pollWords(
  db: NoteDb,
  fetchWord: (id: Uint8Array) => Promise<WordFetch>,
  genesisHash: Uint8Array,
  now: number,
): Promise<number> {
  const asks = await db.all<{ id: Uint8Array; rk_secret: Uint8Array; asked_at: number; polls: number }>(
    'SELECT id, rk_secret, asked_at, polls FROM relay_word_asks WHERE next_poll_at <= ?',
    [now],
  )
  let received = 0
  for (const ask of asks) {
    let result: WordFetch
    try {
      result = await fetchWord(ask.id)
    } catch {
      continue
    }
    if (result.status === 200) {
      try {
        await receiveWord(db, result.body, ask.rk_secret, genesisHash, now)
        received++
      } catch {
        // A word that does not open or verify is of no use to anyone.
      }
    }
    if (result.status === 404 && now - ask.asked_at < ASK_TTL) {
      const wait = Math.min(POLL_MAX, POLL_FIRST * 2 ** (ask.polls + 1))
      await db.run('UPDATE relay_word_asks SET next_poll_at = ?, polls = polls + 1 WHERE id = ?', [now + wait, ask.id])
    } else {
      await db.run('DELETE FROM relay_word_asks WHERE id = ?', [ask.id])
    }
  }
  return received
}

/** What the words held are due for: they are settled once enough have gathered or the oldest has waited long enough. */
export async function dueBatch(
  db: NoteDb,
  { now, batchMin = BATCH_MIN }: { now: number; batchMin?: number },
): Promise<{ words: HeldWord[]; exps: number[] }> {
  const held = (
    await db.all<Stored>(
      'SELECT channel, idx AS "index", commitment, signature, proof, expiry, received_at, state FROM relay_words WHERE state = \'held\' AND expiry > ? ORDER BY received_at',
      [now],
    )
  ).map(toWord)
  const oldest = held[0]
  if (!oldest || (held.length < batchMin && now - oldest.receivedAt < BATCH_WAIT)) return { words: [], exps: [] }
  const words = evenCount(held.slice(0, MAX_WORDS_PER_TX))
  return { words, exps: canonicalExps(words.length) ?? [] }
}

/** An even number of words: when there is an odd one, the word whose window closes last waits for the next batch. */
function evenCount(words: HeldWord[]): HeldWord[] {
  if (words.length % 2 === 0) return words
  const latest = words.reduce((a, b) => (b.expiry >= a.expiry ? b : a))
  return words.filter((word) => word !== latest)
}

/**
 * The size of a settlement transaction of `channels` channels and the words of `depths`, measured on the program:
 * 566 bytes, 472 per channel and 34 + 32 × depth + 4 per word.
 */
export const transactionBytes = (channels: number, wordDepths: readonly number[]) =>
  566 + 472 * channels + wordDepths.reduce((sum, depth) => sum + 38 + 32 * depth, 0)

const depthOf = (word: HeldWord) => (word.proof.length - 34) / 32

/**
 * Splits words into transactions: each takes at most three channels, an even number of words and the 4,096 bytes of a
 * transaction. A word left over because a group would be odd or too large waits for the next batch.
 */
export function packTransactions(words: readonly HeldWord[]): HeldWord[][] {
  const byChannel = new Map<string, HeldWord[]>()
  for (const word of words) {
    const key = bytesToHex(word.channel)
    byChannel.set(key, [...(byChannel.get(key) ?? []), word])
  }
  const groups: HeldWord[][] = []
  let current: HeldWord[] = []
  let channels = 0
  const flush = () => {
    const even = evenCount(current)
    if (even.length) groups.push(even)
    current = []
    channels = 0
  }
  for (const channel of byChannel.values()) {
    const fits = (extra: HeldWord[]) =>
      channels + 1 <= MAX_CHANNELS_PER_TX &&
      transactionBytes(channels + 1, [...current, ...extra].map(depthOf)) <= MAX_TX_BYTES
    let rest = channel
    while (rest.length) {
      let take = rest.length
      while (take > 0 && !fits(rest.slice(0, take))) take--
      if (take === 0) {
        flush()
        take = Math.min(rest.length, 2)
        while (take > 0 && !fits(rest.slice(0, take))) take--
        if (take === 0) break
      }
      current = [...current, ...rest.slice(0, take)]
      channels++
      rest = rest.slice(take)
    }
  }
  flush()
  return groups
}

export type SettleAnswer = { status: 'submitted' | 'duplicate'; jobKey: string } | { status: 'retry' | 'refused' }

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

/**
 * Settles the words that are due through the gateway: one request per transaction, with only the blinded inner of each
 * exponent. The words are `submitted` once the gateway has written the job, and `rejected` when it refuses them.
 */
export async function submitDue(
  db: NoteDb,
  ctx: {
    now: number
    /** The blinded inner `Poseidon(nullifier, trapdoor)` of a new leaf secret for `exp`, which the caller keeps. */
    makeInner: (exp: number) => Promise<Uint8Array>
    post: (body: unknown) => Promise<SettleAnswer>
    batchMin?: number
  },
): Promise<number> {
  const { words } = await dueBatch(db, { now: ctx.now, batchMin: ctx.batchMin })
  let submitted = 0
  for (const group of packTransactions(words)) {
    const exps = canonicalExps(group.length)
    if (!exps) continue
    const channels = new Map<string, { commitment: Uint8Array; words: Uint8Array[] }>()
    for (const word of group) {
      const key = bytesToHex(word.channel)
      const entry = channels.get(key) ?? { commitment: word.commitment, words: [] }
      entry.words.push(word.proof)
      channels.set(key, entry)
    }
    const inners = await Promise.all(exps.map((exp) => ctx.makeInner(exp)))
    const answer = await ctx.post({
      channels: [...channels.values()].map((c) => ({ commitment: b64(c.commitment), words: c.words.map(b64) })),
      inners: inners.map(b64),
    })
    if (answer.status === 'retry') continue
    const next = answer.status === 'refused' ? 'rejected' : 'submitted'
    for (const word of group)
      await db.run('UPDATE relay_words SET state = ? WHERE channel = ? AND idx = ?', [next, word.channel, word.index])
    if (next === 'submitted') submitted += group.length
  }
  return submitted
}

/** Posts the request of one transaction to `POST /v1/channels`. */
export function postChannels(gatewayUrl: string, request: typeof fetch = fetch) {
  return async (body: unknown): Promise<SettleAnswer> => {
    const response = await request(`${gatewayUrl}/v1/channels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`The gateway answered ${response.status}.`)
    return (await response.json()) as SettleAnswer
  }
}

/** Fetches the word of the blob `id`: `404` while it settles, `410` when there will be none. */
export function fetchWord(gatewayUrl: string, request: typeof fetch = fetch) {
  return async (id: Uint8Array): Promise<WordFetch> => {
    const response = await request(`${gatewayUrl}/v1/relay/${bytesToHex(id)}/word`)
    if (response.status === 200) return { status: 200, body: new Uint8Array(await response.arrayBuffer()) }
    if (response.status === 404 || response.status === 410) return { status: response.status }
    throw new Error(`The gateway answered ${response.status}.`)
  }
}
