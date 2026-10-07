import type { NoteDb } from '../notes/db'

export const WORDS_SCHEMA_VERSION = 10

/**
 * Moves the version from 9 to 10: the channels this phone tips with, the words it received for relaying, and the
 * keys it asked the gateway to seal them to. Seeds and keys live in the encrypted note store like note secrets.
 */
export async function migrateWords(db: NoteDb): Promise<void> {
  const [row] = await db.all<{ user_version: number }>('PRAGMA user_version')
  if (row.user_version >= WORDS_SCHEMA_VERSION) return
  if (row.user_version !== 9) throw new Error('The note store must be at version 9 before the words migration')
  await db.exec(`BEGIN;
CREATE TABLE payword_channels (
  hash BLOB PRIMARY KEY CHECK (length(hash) = 32),
  device BLOB NOT NULL,
  lock_seq INTEGER NOT NULL,
  mint BLOB NOT NULL CHECK (length(mint) = 32),
  cum_end INTEGER NOT NULL,
  depth INTEGER NOT NULL CHECK (depth >= 4 AND depth <= 8),
  word_value INTEGER NOT NULL CHECK (word_value > 0),
  expiry INTEGER NOT NULL,
  seed BLOB NOT NULL CHECK (length(seed) = 32),
  signature BLOB CHECK (signature IS NULL OR length(signature) = 64),
  next_index INTEGER NOT NULL DEFAULT 0 CHECK (next_index >= 0),
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX payword_channels_lock ON payword_channels (device, lock_seq, created_at);
CREATE TABLE relay_words (
  channel BLOB NOT NULL CHECK (length(channel) = 32),
  idx INTEGER NOT NULL CHECK (idx >= 0 AND idx < 256),
  commitment BLOB NOT NULL CHECK (length(commitment) = 91),
  signature BLOB NOT NULL CHECK (length(signature) = 64),
  proof BLOB NOT NULL,
  expiry INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held', 'submitted', 'in_tree', 'rejected')),
  PRIMARY KEY (channel, idx)
) WITHOUT ROWID;
CREATE TABLE relay_word_asks (
  id BLOB PRIMARY KEY CHECK (length(id) = 32),
  rk_secret BLOB NOT NULL CHECK (length(rk_secret) = 32),
  asked_at INTEGER NOT NULL,
  next_poll_at INTEGER NOT NULL,
  polls INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
PRAGMA user_version = ${WORDS_SCHEMA_VERSION};
COMMIT;`)
}
