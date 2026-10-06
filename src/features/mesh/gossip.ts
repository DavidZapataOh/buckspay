import { equalBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  decodeIssueConflict,
  decodeSpendConflict,
  SPEND_CONFLICT_WIRE_LEN,
  ProtocolError,
  recoverIssueSigner,
  recoverSpendSigner,
  verifyIssueConflict,
  verifySpendConflict,
} from '../../protocol'
import { type Bundle, decodeBundle } from '../../payment/messages'
import { Reason } from '../../payment/reasons'
import type { ReceiveGate } from '../../payment/receive'
import type { NoteDb } from '../notes/db'
import { type Frame, FrameKind } from './frame'
import { chainKeys } from './known-keys'

export const GOSSIP_SCHEMA_VERSION = 6
/** How long a proof is passed on after this phone first saw it, in seconds. */
export const GOSSIP_TTL = 30 * 60
/** How many proofs are on the air at once. */
export const GOSSIP_SLOTS = 4
const POOL_ROWS = 256

export type FlagSource = 'mesh' | 'point'
export type Accepted =
  | { ok: true; key: Uint8Array; known: boolean; id: Uint8Array }
  | { ok: false; reason: 'Malformed' | 'NoSigner' | 'Invalid' }
export type HeldNote = { outputId: Uint8Array; bundle: Bundle }
type Kind = 'spend' | 'issue'

/** Moves the version from 5 to 6: the keys proven to have signed two contents for one output, and the proofs this phone passes on. */
export async function migrateGossip(db: NoteDb): Promise<void> {
  const [row] = await db.all<{ user_version: number }>('PRAGMA user_version')
  if (row.user_version >= GOSSIP_SCHEMA_VERSION) return
  if (row.user_version !== 5) throw new Error('The note store must be at version 5 before the gossip migration')
  await db.exec(`BEGIN;
CREATE TABLE flagged_keys (
  key BLOB PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('spend', 'issue')),
  proof BLOB NOT NULL,
  first_seen INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('mesh', 'point'))
) WITHOUT ROWID;
CREATE TABLE conflict_pool (
  id BLOB PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('spend', 'issue')),
  key BLOB NOT NULL,
  proof BLOB NOT NULL,
  first_seen INTEGER NOT NULL,
  known INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX conflict_pool_key ON conflict_pool (key);
PRAGMA user_version = ${GOSSIP_SCHEMA_VERSION};
COMMIT;`)
}

/** Checks a conflict proof under the note domain and recovers the key that signed both contents; `known` is for the caller to fill in. */
export function acceptConflict(domain: Uint8Array, kind: Kind, wire: Uint8Array): Accepted {
  let key: Uint8Array
  let check: (signer: Uint8Array) => void
  try {
    if (kind === 'spend') {
      const conflict = decodeSpendConflict(wire)
      key = recoverSpendSigner(domain, conflict)
      check = (signer) => verifySpendConflict(domain, signer, conflict)
    } else {
      const conflict = decodeIssueConflict(wire)
      key = recoverIssueSigner(domain, conflict)
      check = (signer) => verifyIssueConflict(domain, signer, conflict)
    }
  } catch (error) {
    return { ok: false, reason: error instanceof ProtocolError && error.code === 'Signer' ? 'NoSigner' : 'Malformed' }
  }
  try {
    check(key)
  } catch {
    return { ok: false, reason: 'Invalid' }
  }
  return { ok: true, key, known: false, id: sha256(wire) }
}

const kindOf = (wire: Uint8Array): Kind => (wire.length === SPEND_CONFLICT_WIRE_LEN ? 'spend' : 'issue')

/** Keeps a verified proof: flags the key when this phone knows it, and otherwise only keeps the proof to pass on. */
export async function recordConflict(
  db: NoteDb,
  accepted: Extract<Accepted, { ok: true }>,
  wire: Uint8Array,
  source: FlagSource,
  now: number,
): Promise<'flagged' | 'pooled' | 'duplicate'> {
  const kind = kindOf(wire)
  return db.transaction(async (tx) => {
    const [seen] = await tx.all('SELECT 1 AS found FROM conflict_pool WHERE id = ?', [accepted.id])
    if (seen) return 'duplicate'
    await tx.run('INSERT INTO conflict_pool (id, kind, key, proof, first_seen, known) VALUES (?, ?, ?, ?, ?, ?)', [
      accepted.id,
      kind,
      accepted.key,
      wire,
      now,
      accepted.known ? 1 : 0,
    ])
    const [{ rows }] = await tx.all<{ rows: number }>('SELECT count(*) AS rows FROM conflict_pool')
    if (rows > POOL_ROWS) {
      await tx.run(
        'DELETE FROM conflict_pool WHERE id IN (SELECT id FROM conflict_pool ORDER BY known, first_seen LIMIT ?)',
        [rows - POOL_ROWS],
      )
    }
    if (!accepted.known) return 'pooled'
    await tx.run('INSERT OR IGNORE INTO flagged_keys (key, kind, proof, first_seen, source) VALUES (?, ?, ?, ?, ?)', [
      accepted.key,
      kind,
      wire,
      now,
      source,
    ])
    return 'flagged'
  })
}

export async function isFlagged(db: NoteDb, key: Uint8Array): Promise<boolean> {
  const [row] = await db.all('SELECT 1 AS found FROM flagged_keys WHERE key = ?', [key])
  return row !== undefined
}

export async function countFlagged(db: NoteDb): Promise<number> {
  const [row] = await db.all<{ total: number }>('SELECT count(*) AS total FROM flagged_keys')
  return row.total
}

/** The flagged keys among the issuer and holders of a chain. */
export async function flaggedSigners(db: NoteDb, bundle: Bundle): Promise<Uint8Array[]> {
  const flagged: Uint8Array[] = []
  for (const key of chainKeys(bundle)) {
    if (!flagged.some((seen) => equalBytes(seen, key)) && (await isFlagged(db, key))) flagged.push(key)
  }
  return flagged
}

/** A key just became known: flags it from a proof that was only pooled. */
export async function promotePooled(db: NoteDb, key: Uint8Array): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx.all<{ kind: Kind; proof: Uint8Array; first_seen: number }>(
      'SELECT kind, proof, first_seen FROM conflict_pool WHERE key = ? AND known = 0 ORDER BY first_seen LIMIT 1',
      [key],
    )
    if (!row) return false
    await tx.run('UPDATE conflict_pool SET known = 1 WHERE key = ?', [key])
    await tx.run('INSERT OR IGNORE INTO flagged_keys (key, kind, proof, first_seen, source) VALUES (?, ?, ?, ?, ?)', [
      key,
      row.kind,
      row.proof,
      row.first_seen,
      'mesh',
    ])
    return true
  })
}

/** The proofs to have on the air at `now`: those of known keys first, then the newest, none older than the TTL. */
export async function toAdvertise(db: NoteDb, now: number, max: number): Promise<{ id: string; frame: Frame }[]> {
  const rows = await db.all<{ id: Uint8Array; kind: Kind; proof: Uint8Array }>(
    'SELECT id, kind, proof FROM conflict_pool WHERE first_seen + ? >= ? ORDER BY known DESC, first_seen DESC LIMIT ?',
    [GOSSIP_TTL, now, max],
  )
  return rows.map((row) => ({
    id: bytesToHex(row.id),
    frame: { kind: row.kind === 'spend' ? FrameKind.SpendConflict : FrameKind.IssueConflict, payload: row.proof },
  }))
}

/** Held notes with a flagged key in their chain. */
export async function heldWithFlagged(db: NoteDb): Promise<HeldNote[]> {
  const rows = await db.all<{ output_id: Uint8Array; bundle: Uint8Array }>(
    "SELECT output_id, bundle FROM received_note WHERE state IN ('held', 'settling') ORDER BY expiry",
  )
  const held: HeldNote[] = []
  for (const row of rows) {
    const bundle = decodeBundle(row.bundle)
    if ((await flaggedSigners(db, bundle)).length > 0) held.push({ outputId: row.output_id, bundle })
  }
  return held
}

/** The notes whose chain has no flagged key: what this phone may still pass on. */
export async function withoutFlagged<T extends { bundle: Bundle }>(db: NoteDb, held: readonly T[]): Promise<T[]> {
  const clean: T[] = []
  for (const note of held) if ((await flaggedSigners(db, note.bundle)).length === 0) clean.push(note)
  return clean
}

/** Refuses a payment whose chain has a flagged key; a key seen here for the first time is checked against the pooled proofs. */
export function flaggedGate(db: NoteDb): ReceiveGate {
  return {
    async admit(_received, bundle) {
      for (const key of chainKeys(bundle)) await promotePooled(db, key)
      return (await flaggedSigners(db, bundle)).length > 0 ? Reason.KeyFlagged : null
    },
  }
}
