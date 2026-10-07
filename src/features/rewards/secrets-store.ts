import type { NoteDb } from '../notes/db'

export const REWARDS_SCHEMA_VERSION = 11

/**
 * Moves the version from 10 to 11: the secrets of the reward leaves this phone made for its relaying, and what became
 * of each claim. They live in the encrypted note store like note secrets and are not part of any backup: a lost phone
 * loses the rewards it had not claimed.
 */
export async function migrateRewards(db: NoteDb): Promise<void> {
  const [row] = await db.all<{ user_version: number }>('PRAGMA user_version')
  if (row.user_version >= REWARDS_SCHEMA_VERSION) return
  if (row.user_version !== 10) throw new Error('The note store must be at version 10 before the rewards migration')
  await db.exec(`BEGIN;
CREATE TABLE leaf_secrets (
  leaf BLOB PRIMARY KEY CHECK (length(leaf) = 32),
  nullifier BLOB NOT NULL CHECK (length(nullifier) = 32),
  trapdoor BLOB NOT NULL CHECK (length(trapdoor) = 32),
  inner BLOB NOT NULL CHECK (length(inner) = 32),
  exp INTEGER NOT NULL CHECK (exp >= 1 AND exp <= 7),
  epoch INTEGER CHECK (epoch IS NULL OR epoch >= 0),
  leaf_index INTEGER CHECK (leaf_index IS NULL OR leaf_index >= 0),
  state TEXT NOT NULL CHECK (state IN ('made', 'in_tree', 'proving', 'submitted', 'claimed', 'failed')),
  claim_at INTEGER,
  recipient BLOB CHECK (recipient IS NULL OR length(recipient) = 32),
  recipient_secret BLOB CHECK (recipient_secret IS NULL OR length(recipient_secret) = 32),
  job_key TEXT,
  signature TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX leaf_secrets_due ON leaf_secrets (state, claim_at);
PRAGMA user_version = ${REWARDS_SCHEMA_VERSION};
COMMIT;`)
}
