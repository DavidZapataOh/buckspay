import type { NoteDb } from '../notes/db'

export const REMOTE_SCHEMA_VERSION = 8

/**
 * Moves the version from 7 to 8: the outbox also holds remote payments (their copies, state and what their record
 * will hold), and the phone keeps contacts and the blobs it carries for others. SQLite cannot change a CHECK list,
 * so the outbox is rebuilt.
 */
export async function migrateRemote(db: NoteDb): Promise<void> {
  const [row] = await db.all<{ user_version: number }>('PRAGMA user_version')
  if (row.user_version >= REMOTE_SCHEMA_VERSION) return
  if (row.user_version !== 7) throw new Error('The note store must be at version 7 before the remote migration')
  await db.exec(`BEGIN;
CREATE TABLE relay_outbox_next (
  id BLOB PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('settle', 'remote')),
  ref TEXT NOT NULL UNIQUE,
  blob BLOB NOT NULL,
  secret BLOB NOT NULL CHECK (length(secret) = 32),
  cluster_tag BLOB NOT NULL CHECK (length(cluster_tag) = 4),
  stored_by INTEGER NOT NULL,
  answer TEXT CHECK (answer IN ('submitted', 'duplicate', 'settled', 'retry', 'refused')),
  next_hand_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  copies_left INTEGER NOT NULL DEFAULT 0,
  state TEXT CHECK (state IN ('signed', 'received', 'relaying', 'delivered', 'expired', 'refused')),
  message_id BLOB,
  content BLOB,
  conflict INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
INSERT INTO relay_outbox_next (id, kind, ref, blob, secret, cluster_tag, stored_by, answer, next_hand_at, created_at, expires_at)
  SELECT id, kind, ref, blob, secret, cluster_tag, stored_by, answer, next_hand_at, created_at, expires_at FROM relay_outbox;
DROP TABLE relay_outbox;
ALTER TABLE relay_outbox_next RENAME TO relay_outbox;
CREATE TABLE contacts (
  wallet BLOB PRIMARY KEY CHECK (length(wallet) = 32),
  mint BLOB NOT NULL CHECK (length(mint) = 32),
  name TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  "check" TEXT NOT NULL CHECK ("check" IN ('verified', 'no-account', 'not-checked')),
  checked_at INTEGER
) WITHOUT ROWID;
CREATE TABLE carry (
  id BLOB PRIMARY KEY,
  blob BLOB NOT NULL,
  copies INTEGER NOT NULL CHECK (copies >= 1),
  received_at INTEGER NOT NULL
) WITHOUT ROWID;
PRAGMA user_version = ${REMOTE_SCHEMA_VERSION};
COMMIT;`)
}
