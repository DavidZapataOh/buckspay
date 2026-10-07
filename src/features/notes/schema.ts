import type { NoteDb } from './db'
import { migrateEvent } from '../event/store'
import { migrateWitness } from './witness-store'
import { migrateGossip } from '../mesh/gossip'
import { migrateMesh } from '../mesh/locked-queue'
import { migrateRelay } from '../relay/store'
import { migrateRemote } from '../remote/store'
import { migrateZk, ZK_SCHEMA_VERSION } from '../zk/proof-store'

export const SCHEMA_VERSION = 1
export const RESPEND_SCHEMA_VERSION = 3

const receivedNote = (name: string, states: string) => `CREATE TABLE ${name} (
  output_id BLOB PRIMARY KEY CHECK (length(output_id) = 32),
  message_id BLOB NOT NULL UNIQUE CHECK (length(message_id) = 32),
  owner BLOB NOT NULL,
  mint BLOB NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  expiry INTEGER NOT NULL,
  hops_left INTEGER NOT NULL,
  caveats BLOB NOT NULL,
  issuer BLOB NOT NULL,
  lock_seq INTEGER NOT NULL,
  bundle BLOB NOT NULL,
  state TEXT NOT NULL CHECK (state IN (${states})),
  requested_amount INTEGER,
  memo TEXT,
  transport TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settlement_body BLOB,
  settlement_spend BLOB,
  witness BLOB
);`

const STATES = "'held', 'settling', 'settled', 'spent', 'expired', 'lost', 'conflicted'"

export const SCHEMA = `
${receivedNote('received_note', STATES)}
CREATE TABLE note_liability (
  output_id BLOB NOT NULL REFERENCES received_note (output_id),
  device BLOB NOT NULL,
  lock_seq INTEGER NOT NULL,
  bond INTEGER NOT NULL,
  attester INTEGER NOT NULL,
  PRIMARY KEY (output_id, device, lock_seq)
);
CREATE INDEX note_liability_lock ON note_liability (device, lock_seq);
CREATE TABLE issue_claim (
  issuer BLOB NOT NULL,
  lock_seq INTEGER NOT NULL,
  start INTEGER NOT NULL,
  "end" INTEGER NOT NULL,
  content BLOB NOT NULL,
  wire BLOB NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, lock_seq, start, "end", content)
);
CREATE INDEX issue_claim_lock ON issue_claim (issuer, lock_seq, start);
CREATE TABLE spend_claim (
  input BLOB NOT NULL,
  content BLOB NOT NULL,
  wire BLOB NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (input, content)
);
CREATE TABLE conflict_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'spend')),
  refused BLOB NOT NULL,
  existing BLOB NOT NULL,
  seen_at INTEGER NOT NULL
);
CREATE TABLE outgoing_payment (
  message_id BLOB PRIMARY KEY CHECK (length(message_id) = 32),
  device BLOB NOT NULL,
  request_id BLOB,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'signed', 'confirmed', 'rejected', 'abandoned')),
  receiver BLOB NOT NULL,
  mint BLOB NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  lock_seq INTEGER NOT NULL,
  cum_start INTEGER NOT NULL,
  cum_end INTEGER NOT NULL,
  expiry INTEGER NOT NULL,
  issue_body BLOB NOT NULL,
  ticket BLOB NOT NULL,
  signature BLOB,
  bundle BLOB,
  memo TEXT,
  transport TEXT,
  reason INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX outgoing_interval ON outgoing_payment (device, lock_seq, cum_start);
CREATE INDEX outgoing_request ON outgoing_payment (request_id);
CREATE TABLE lock_cursor (
  device BLOB NOT NULL,
  lock_seq INTEGER NOT NULL,
  next_cum_end INTEGER NOT NULL,
  PRIMARY KEY (device, lock_seq)
);
`

/** Creates the tables on a new database and applies the later migrations; refuses a database of a newer version. Versioned with `PRAGMA user_version`. */
export async function migrate(db: NoteDb): Promise<void> {
  const [row] = await db.all<{ user_version: number }>('PRAGMA user_version')
  if (row.user_version > ZK_SCHEMA_VERSION)
    throw new Error(`The note store is version ${row.user_version}, newer than this app.`)
  if (row.user_version < SCHEMA_VERSION)
    await db.exec(`BEGIN; ${SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`)
  await migrateWitness(db)
  await migrateRespend(db)
  await migrateEvent(db)
  await migrateMesh(db)
  await migrateGossip(db)
  await migrateRelay(db)
  await migrateRemote(db)
  await migrateZk(db)
}

/**
 * Moves the version from 2 to 3: a note being passed on is `spending`, and a payment can be the spend of a
 * held note (`input`), at most one per note. SQLite cannot change a CHECK list, so the table is rebuilt.
 */
async function migrateRespend(db: NoteDb): Promise<void> {
  const [row] = await db.all<{ user_version: number }>('PRAGMA user_version')
  if (row.user_version >= RESPEND_SCHEMA_VERSION) return
  if (row.user_version !== 2) throw new Error('The note store must be at version 2 before the re-spend migration')
  await db.exec(`BEGIN;
${receivedNote('received_note_next', `${STATES}, 'spending'`)}
INSERT INTO received_note_next SELECT * FROM received_note;
DROP TABLE received_note;
ALTER TABLE received_note_next RENAME TO received_note;
ALTER TABLE outgoing_payment ADD COLUMN input BLOB;
DROP INDEX outgoing_interval;
CREATE UNIQUE INDEX outgoing_interval ON outgoing_payment (device, lock_seq, cum_start) WHERE input IS NULL;
CREATE UNIQUE INDEX outgoing_input ON outgoing_payment (input) WHERE input IS NOT NULL;
PRAGMA user_version = ${RESPEND_SCHEMA_VERSION};
COMMIT;`)
}
