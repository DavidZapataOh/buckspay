import type { NoteDb } from '../notes/db'

export const RELAY_SCHEMA_VERSION = 7

/**
 * Moves the version from 6 to 7: the messages this phone sends through others, the blobs it carries for others and
 * the gateway configuration it last fetched. A relayer's tables hold sealed bytes and counts only.
 */
export async function migrateRelay(db: NoteDb): Promise<void> {
  const [row] = await db.all<{ user_version: number }>('PRAGMA user_version')
  if (row.user_version >= RELAY_SCHEMA_VERSION) return
  if (row.user_version !== 6) throw new Error('The note store must be at version 6 before the relay migration')
  await db.exec(`BEGIN;
CREATE TABLE relay_outbox (
  id BLOB PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('settle')),
  ref TEXT NOT NULL UNIQUE,
  blob BLOB NOT NULL,
  secret BLOB NOT NULL CHECK (length(secret) = 32),
  cluster_tag BLOB NOT NULL CHECK (length(cluster_tag) = 4),
  stored_by INTEGER NOT NULL,
  answer TEXT CHECK (answer IN ('submitted', 'duplicate', 'settled', 'retry', 'refused')),
  next_hand_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE relay_inbox (
  id BLOB PRIMARY KEY,
  blob BLOB NOT NULL,
  received_at INTEGER NOT NULL,
  peer TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE relay_seen (
  id BLOB PRIMARY KEY,
  response BLOB NOT NULL,
  answered_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE relay_peers (
  peer TEXT PRIMARY KEY,
  strikes INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE relay_hits (peer TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX relay_hits_at ON relay_hits (at);
CREATE TABLE relay_counter (id INTEGER PRIMARY KEY CHECK (id = 1), carried INTEGER NOT NULL);
INSERT INTO relay_counter (id, carried) VALUES (1, 0);
CREATE TABLE relay_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fetched_at INTEGER NOT NULL,
  keys TEXT NOT NULL
);
PRAGMA user_version = ${RELAY_SCHEMA_VERSION};
COMMIT;`)
}
