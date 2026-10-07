import { sha256 } from '@noble/hashes/sha2.js'
import type { NoteDb } from '../notes/db'
import { plausible, RelayRejected } from './inbox'
import { askFor } from './words'

/** Copies a payer sprays: half goes to the first carrier it meets, half of what is left to the next. */
export const SPRAY_COPIES = 8
export const CARRY_BLOBS = 64
/** Seconds a blob is carried from the moment it arrived: no note expiry is revealed to a carrier. */
export const CARRY_SECONDS = 72 * 3600
/** The most copies a peer can claim for what it hands over: a payer gives half of `SPRAY_COPIES` at most. */
const MAX_CLAIMED = SPRAY_COPIES / 2

/** Binary Spray-and-Wait: hand over half, keep the rest, and keep at least one. */
export function split(copies: number): { give: number; keep: number } {
  const give = Math.floor(copies / 2)
  return { give, keep: copies - give }
}

/** A frame is `copies u8 ‖ blob` for a carrier, or the bare blob for a relayer: the sizes of a blob never overlap. */
export function parseFrame(frame: Uint8Array): { blob: Uint8Array; copies: number } | null {
  if (plausible(frame)) return { blob: frame, copies: 0 }
  if (frame.length > 1 && frame[0] > 0 && plausible(frame.subarray(1)))
    return { blob: frame.subarray(1), copies: frame[0] }
  return null
}

/** Keeps a blob handed by a nearby phone, once, within the caps. The copies it claims are clamped. */
export async function acceptCarry(
  db: NoteDb,
  blob: Uint8Array,
  copies: number,
  now: number,
): Promise<'stored' | 'full' | 'repeat' | 'dropped'> {
  if (!plausible(blob)) return 'dropped'
  await db.run('DELETE FROM carry WHERE received_at <= ?', [now - CARRY_SECONDS])
  const id = sha256(blob)
  const [known] = await db.all('SELECT 1 AS found FROM carry WHERE id = ?', [id])
  if (known) return 'repeat'
  const [{ count }] = await db.all<{ count: number }>('SELECT COUNT(*) AS count FROM carry')
  if (count >= CARRY_BLOBS) return 'full'
  const kept = Math.max(1, Math.min(copies, MAX_CLAIMED))
  await db.run('INSERT INTO carry (id, blob, copies, received_at) VALUES (?, ?, ?, ?)', [id, blob, kept, now])
  return 'stored'
}

/**
 * What to hand to a phone in range. An online phone gets every blob (it posts them); a carrier gets half the copies of
 * each blob that still has more than one, and the rest stay here.
 */
export async function toHand(
  db: NoteDb,
  peer: { online: boolean },
  now: number,
): Promise<{ id: Uint8Array; blob: Uint8Array; copies: number }[]> {
  await db.run('DELETE FROM carry WHERE received_at <= ?', [now - CARRY_SECONDS])
  const rows = await db.all<{ id: Uint8Array; blob: Uint8Array; copies: number }>(
    'SELECT id, blob, copies FROM carry ORDER BY received_at',
  )
  if (peer.online) return rows
  const handed: { id: Uint8Array; blob: Uint8Array; copies: number }[] = []
  for (const row of rows) {
    const { give, keep } = split(row.copies)
    if (give < 1) continue
    await db.run('UPDATE carry SET copies = ? WHERE id = ?', [keep, row.id])
    handed.push({ id: row.id, blob: row.blob, copies: give })
  }
  return handed
}

/** Puts back copies handed to a phone that did not keep them. */
export async function restore(db: NoteDb, id: Uint8Array, copies: number): Promise<void> {
  await db.run('UPDATE carry SET copies = copies + ? WHERE id = ?', [copies, id])
}

/** An online phone answered for this blob: no other copy is worth carrying. */
export async function answeredByRelayer(db: NoteDb, id: Uint8Array, _now: number): Promise<void> {
  await db.run('DELETE FROM carry WHERE id = ?', [id])
}

/**
 * A phone that came online posts what it carries: the gateway settles each blob once, whoever posts it. A blob the
 * gateway refuses outright is dropped; one it could not be given to stays for the next time.
 */
export async function postCarried(
  db: NoteDb,
  post: (blob: Uint8Array, rk: Uint8Array) => Promise<Uint8Array>,
  now: number,
): Promise<number> {
  let posted = 0
  for (const row of await toHand(db, { online: true }, now)) {
    try {
      await post(row.blob, await askFor(db, row.id, now))
      posted++
    } catch (error) {
      await db.run('DELETE FROM relay_word_asks WHERE id = ?', [row.id])
      if (!(error instanceof RelayRejected)) continue
    }
    await answeredByRelayer(db, row.id, now)
  }
  return posted
}
