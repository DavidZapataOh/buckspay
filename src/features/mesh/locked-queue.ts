import type { NoteDb } from '../notes/db'

export const MESH_SCHEMA_VERSION = 5

/** Work that needs the device key, so it waits until the person unlocks the phone. */
export type SignatureJob = { id: string; kind: 'reclaim'; payload: Uint8Array; notAfter: number }

/** Moves the version from 4 to 5: the signature jobs queued while the phone is locked. */
export async function migrateMesh(db: NoteDb): Promise<void> {
  const [row] = await db.all<{ user_version: number }>('PRAGMA user_version')
  if (row.user_version >= MESH_SCHEMA_VERSION) return
  if (row.user_version !== 4) throw new Error('The note store must be at version 4 before the mesh migration')
  await db.exec(`BEGIN;
CREATE TABLE mesh_signature_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('reclaim')),
  payload BLOB NOT NULL,
  not_after INTEGER NOT NULL
) WITHOUT ROWID;
PRAGMA user_version = ${MESH_SCHEMA_VERSION};
COMMIT;`)
}

export async function enqueue(db: NoteDb, job: SignatureJob): Promise<void> {
  await db.run('INSERT OR IGNORE INTO mesh_signature_jobs (id, kind, payload, not_after) VALUES (?, ?, ?, ?)', [
    job.id,
    job.kind,
    job.payload,
    job.notAfter,
  ])
}

/** Runs each queued job once and removes it; an expired job is dropped unrun and one that throws stays for the next unlock. */
export async function runUnlocked(
  db: NoteDb,
  run: (job: SignatureJob) => Promise<void>,
  now: number,
): Promise<{ ran: number; expired: number }> {
  const rows = await db.all<{ id: string; kind: 'reclaim'; payload: Uint8Array; not_after: number }>(
    'SELECT id, kind, payload, not_after FROM mesh_signature_jobs ORDER BY not_after',
  )
  let ran = 0
  let expired = 0
  for (const row of rows) {
    const job = { id: row.id, kind: row.kind, payload: row.payload, notAfter: row.not_after }
    if (job.notAfter <= now) {
      expired++
    } else {
      try {
        await run(job)
      } catch {
        continue
      }
      ran++
    }
    await db.run('DELETE FROM mesh_signature_jobs WHERE id = ?', [job.id])
  }
  return { ran, expired }
}
