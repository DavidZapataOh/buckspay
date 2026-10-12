import { bytesToHex } from '@noble/hashes/utils.js'
import type { NoteDb } from '../notes/db'

export const RETRY_SCHEMA_VERSION = 14

/** What the gateway said the last time it refused a note, and when this phone may ask again. */
export type Retry = {
  attempts: number
  nextAt: number
  kind: string
  selfPay: boolean
  reason?: string
  retryAt?: number
}

/** Adds the table of the next try of each note: asking again on every foreground or network event would hammer the gateway. */
export async function migrateRetry(db: NoteDb): Promise<void> {
  const [row] = await db.all<{ user_version: number }>('PRAGMA user_version')
  if (row.user_version >= RETRY_SCHEMA_VERSION) return
  if (row.user_version !== 13)
    throw new Error('The note store must be at version 13 before the settlement retry migration')
  await db.exec(`BEGIN;
CREATE TABLE settlement_retry (
  output_id BLOB PRIMARY KEY CHECK (length(output_id) = 32),
  attempts INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  self_pay INTEGER NOT NULL,
  reason TEXT,
  retry_at INTEGER
);
PRAGMA user_version = ${RETRY_SCHEMA_VERSION};
COMMIT;`)
}

export async function loadRetries(db: NoteDb): Promise<Map<string, Retry>> {
  const rows = await db.all<{
    output_id: Uint8Array
    attempts: number
    next_at: number
    kind: string
    self_pay: number
    reason: string | null
    retry_at: number | null
  }>('SELECT output_id, attempts, next_at, kind, self_pay, reason, retry_at FROM settlement_retry')
  return new Map(
    rows.map((r) => [
      bytesToHex(r.output_id),
      {
        attempts: r.attempts,
        nextAt: r.next_at,
        kind: r.kind,
        selfPay: r.self_pay === 1,
        ...(r.reason === null ? {} : { reason: r.reason }),
        ...(r.retry_at === null ? {} : { retryAt: r.retry_at }),
      },
    ]),
  )
}

export async function saveRetry(db: NoteDb, outputId: Uint8Array, retry: Retry): Promise<void> {
  await db.run(
    'INSERT OR REPLACE INTO settlement_retry (output_id, attempts, next_at, kind, self_pay, reason, retry_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      outputId,
      retry.attempts,
      retry.nextAt,
      retry.kind,
      retry.selfPay ? 1 : 0,
      retry.reason ?? null,
      retry.retryAt ?? null,
    ],
  )
}

export async function clearRetry(db: NoteDb, outputId: Uint8Array): Promise<void> {
  await db.run('DELETE FROM settlement_retry WHERE output_id = ?', [outputId])
}
