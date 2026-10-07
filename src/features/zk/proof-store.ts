import type { NoteDb } from '../notes/db'
import { PROOF_BYTES, PUBLIC_BYTES, type ZkProof } from './types'

export const ZK_SCHEMA_VERSION = 9

/** One proof per message of a note: the proofs the phone made and has not yet submitted. */
export async function migrateZk(db: NoteDb): Promise<void> {
  const [row] = await db.all<{ user_version: number }>('PRAGMA user_version')
  if (row.user_version >= ZK_SCHEMA_VERSION) return
  await db.exec(`BEGIN;
CREATE TABLE zk_proofs (
  note_id TEXT NOT NULL,
  idx INTEGER NOT NULL CHECK (idx >= 0 AND idx < 17),
  vk_sha256 TEXT NOT NULL,
  proof BLOB NOT NULL CHECK (length(proof) = ${PROOF_BYTES}),
  public_inputs BLOB NOT NULL CHECK (length(public_inputs) = ${PUBLIC_BYTES}),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, idx)
);
PRAGMA user_version = ${ZK_SCHEMA_VERSION};
COMMIT;`)
}

/** Stores a proof, replacing the one of the same message. */
export async function put(
  db: NoteDb,
  noteId: string,
  proof: ZkProof,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  if (proof.proof.length !== PROOF_BYTES || proof.publicInputs.length !== PUBLIC_BYTES) {
    throw new Error('A proof is 192 bytes with 320 bytes of public inputs.')
  }
  await db.run(
    `INSERT INTO zk_proofs (note_id, idx, vk_sha256, proof, public_inputs, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (note_id, idx) DO UPDATE SET vk_sha256 = excluded.vk_sha256, proof = excluded.proof,
       public_inputs = excluded.public_inputs, created_at = excluded.created_at`,
    [noteId, proof.index, proof.vkSha256, proof.proof, proof.publicInputs, now],
  )
}

export async function list(db: NoteDb, noteId: string): Promise<ZkProof[]> {
  const rows = await db.all<{ idx: number; vk_sha256: string; proof: Uint8Array; public_inputs: Uint8Array }>(
    'SELECT idx, vk_sha256, proof, public_inputs FROM zk_proofs WHERE note_id = ? ORDER BY idx',
    [noteId],
  )
  return rows.map((row) => ({
    index: row.idx,
    vkSha256: row.vk_sha256,
    proof: row.proof,
    publicInputs: row.public_inputs,
  }))
}

/** Forgets the proofs made under any key but `vkSha256`. */
export const dropStale = (db: NoteDb, vkSha256: string) =>
  db.run('DELETE FROM zk_proofs WHERE vk_sha256 <> ?', [vkSha256])

export const dropNote = (db: NoteDb, noteId: string) => db.run('DELETE FROM zk_proofs WHERE note_id = ?', [noteId])
