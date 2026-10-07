import { sha256 } from '@noble/hashes/sha2.js'
import { PINNED_GATEWAY_KEYS } from '../../protocol/hpke'
import type { NoteDb } from '../notes/db'
import { BUCKETS } from './inner'
import { askFor } from './words'

/** `keyId u8 ‖ enc 32` before the ciphertext, whose tag is 16 bytes. */
const OVERHEAD = 1 + 32 + 16
export const INBOX_BLOBS = 64
export const PEER_PER_MINUTE = 6
export const ALL_PER_MINUTE = 30
/** Seconds a relayed answer is kept to give a repeat the same one without posting. */
export const SEEN_SECONDS = 86_400
const BACKOFF_FIRST = 10
const BACKOFF_MAX = 3_600

export type Accepted = 'stored' | 'full' | 'dropped' | { repeat: Uint8Array | null }

const idOf = (blob: Uint8Array) => sha256(blob)

/** Whether `blob` is the size and the key of something the gateway could open: cheap checks before anything is kept. */
export const plausible = (blob: Uint8Array) =>
  BUCKETS.some((bucket) => blob.length === bucket + OVERHEAD) &&
  PINNED_GATEWAY_KEYS.some((key) => key.keyId === blob[0])

/**
 * What a relayer does with a blob a nearby phone hands it: refuse what is not plausible or comes too often, answer a
 * repeat with the answer it kept, and otherwise store it for `forward`.
 */
export async function accept(db: NoteDb, blob: Uint8Array, now: number, peer: string): Promise<Accepted> {
  if (!plausible(blob)) return 'dropped'
  const [blocked] = await db.all<{ blocked_until: number }>('SELECT blocked_until FROM relay_peers WHERE peer = ?', [
    peer,
  ])
  if (blocked && blocked.blocked_until > now) return 'dropped'
  const id = idOf(blob)
  const [seen] = await db.all<{ response: Uint8Array }>('SELECT response FROM relay_seen WHERE id = ?', [id])
  if (seen) return { repeat: seen.response }
  const [{ mine }] = await db.all<{ mine: number }>(
    'SELECT COUNT(*) AS mine FROM relay_hits WHERE peer = ? AND at > ?',
    [peer, now - 60],
  )
  const [{ total }] = await db.all<{ total: number }>('SELECT COUNT(*) AS total FROM relay_hits WHERE at > ?', [
    now - 60,
  ])
  if (mine >= PEER_PER_MINUTE || total >= ALL_PER_MINUTE) return 'dropped'
  await db.run('DELETE FROM relay_hits WHERE at <= ?', [now - 60])
  await db.run('INSERT INTO relay_hits (peer, at) VALUES (?, ?)', [peer, now])
  const [waiting] = await db.all<{ id: Uint8Array }>('SELECT id FROM relay_inbox WHERE id = ?', [id])
  if (waiting) return 'stored'
  const [{ count }] = await db.all<{ count: number }>('SELECT COUNT(*) AS count FROM relay_inbox')
  if (count >= INBOX_BLOBS) return 'full'
  await db.run('INSERT INTO relay_inbox (id, blob, received_at, peer) VALUES (?, ?, ?, ?)', [id, blob, now, peer])
  return 'stored'
}

/** The gateway refused the blob outright (a `400`): the sender is not to try again soon. */
export class RelayRejected extends Error {}

/**
 * Posts what waits to the gateway through `post`, with a key to seal the word of the payment to, keeps the sealed answer
 * for a day and forgets the blob.
 * A blob the gateway refuses outright puts its sender in an exponential backoff; one that could not be posted stays.
 */
export async function forward(
  db: NoteDb,
  post: (blob: Uint8Array, rk: Uint8Array) => Promise<Uint8Array>,
  now: number,
): Promise<number> {
  await db.run('DELETE FROM relay_seen WHERE answered_at <= ?', [now - SEEN_SECONDS])
  const waiting = await db.all<{ id: Uint8Array; blob: Uint8Array; peer: string }>(
    'SELECT id, blob, peer FROM relay_inbox ORDER BY received_at',
  )
  let posted = 0
  for (const { id, blob, peer } of waiting) {
    let response: Uint8Array
    try {
      response = await post(blob, await askFor(db, id, now))
    } catch (error) {
      await db.run('DELETE FROM relay_word_asks WHERE id = ?', [id])
      if (!(error instanceof RelayRejected)) continue
      await db.run('DELETE FROM relay_inbox WHERE id = ?', [id])
      const [row] = await db.all<{ strikes: number }>('SELECT strikes FROM relay_peers WHERE peer = ?', [peer])
      const strikes = (row?.strikes ?? 0) + 1
      const wait = Math.min(BACKOFF_MAX, BACKOFF_FIRST * 2 ** (strikes - 1))
      await db.run('INSERT OR REPLACE INTO relay_peers (peer, strikes, blocked_until) VALUES (?, ?, ?)', [
        peer,
        strikes,
        now + wait,
      ])
      continue
    }
    await db.transaction(async (tx) => {
      await tx.run('INSERT OR REPLACE INTO relay_seen (id, response, answered_at) VALUES (?, ?, ?)', [
        id,
        response,
        now,
      ])
      await tx.run('DELETE FROM relay_inbox WHERE id = ?', [id])
      await tx.run('UPDATE relay_counter SET carried = carried + 1')
    })
    posted++
  }
  return posted
}

/** How many answers this phone has carried for others: the count the settings show. */
export async function carried(db: NoteDb): Promise<number> {
  const [row] = await db.all<{ carried: number }>('SELECT carried FROM relay_counter')
  return row.carried
}
