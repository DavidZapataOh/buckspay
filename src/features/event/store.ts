import type { NoteDb } from '../notes/db'
import { decodePairing, encodePairing, type EventInvite, type PointPairing } from './payloads'

export const EVENT_SCHEMA_VERSION = 4

export type EventRole = 'attendee' | 'point' | 'organiser'

export type StoredEvent = EventInvite & { role: EventRole }

/** Moves the version from 3 to 4: the events a phone joined, runs or serves as a point, and what a point recorded. */
export async function migrateEvent(db: NoteDb): Promise<void> {
  const [row] = await db.all<{ user_version: number }>('PRAGMA user_version')
  if (row.user_version >= EVENT_SCHEMA_VERSION) return
  if (row.user_version !== 3) throw new Error('The note store must be at version 3 before the event migration')
  await db.exec(`BEGIN;
CREATE TABLE event (
  event_id BLOB NOT NULL CHECK (length(event_id) = 16),
  role TEXT NOT NULL CHECK (role IN ('attendee', 'point', 'organiser')),
  authority BLOB NOT NULL CHECK (length(authority) = 32),
  name TEXT NOT NULL,
  ends_at INTEGER NOT NULL,
  pairing BLOB,
  PRIMARY KEY (event_id, role)
) WITHOUT ROWID;
CREATE TABLE event_consumed (
  event_id BLOB NOT NULL,
  output_id BLOB NOT NULL CHECK (length(output_id) = 32),
  content BLOB NOT NULL CHECK (length(content) = 32),
  signature BLOB NOT NULL CHECK (length(signature) = 64),
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, output_id)
) WITHOUT ROWID;
CREATE INDEX event_consumed_seen ON event_consumed (event_id, seen_at);
CREATE TABLE event_blocked (
  event_id BLOB NOT NULL,
  key BLOB NOT NULL CHECK (length(key) = 33),
  PRIMARY KEY (event_id, key)
) WITHOUT ROWID;
CREATE TABLE event_conflict (
  event_id BLOB NOT NULL,
  output_id BLOB NOT NULL,
  conflict BLOB NOT NULL,
  PRIMARY KEY (event_id, output_id)
) WITHOUT ROWID;
PRAGMA user_version = ${EVENT_SCHEMA_VERSION};
COMMIT;`)
}

type Row = { event_id: Uint8Array; role: EventRole; authority: Uint8Array; name: string; ends_at: number }

const SELECT = 'SELECT event_id, role, authority, name, ends_at FROM event'

const eventOf = (row: Row): StoredEvent => ({
  eventId: row.event_id,
  role: row.role,
  authority: row.authority,
  name: row.name,
  endsAt: row.ends_at,
})

/** Joins an event from its invite: `ended` when it is over, `known` when it was already joined. */
export async function joinEvent(db: NoteDb, invite: EventInvite, now: number): Promise<'joined' | 'known' | 'ended'> {
  if (invite.endsAt <= now) return 'ended'
  const [known] = await db.all("SELECT 1 AS found FROM event WHERE event_id = ? AND role = 'attendee'", [
    invite.eventId,
  ])
  if (known) return 'known'
  await db.run("INSERT INTO event (event_id, role, authority, name, ends_at) VALUES (?, 'attendee', ?, ?, ?)", [
    invite.eventId,
    invite.authority,
    invite.name,
    invite.endsAt,
  ])
  return 'joined'
}

/** The authorities whose event credit this phone accepts: those of the events it joined that have not ended. */
export async function joinedAuthorities(db: NoteDb, now: number): Promise<Uint8Array[]> {
  const rows = await db.all<{ authority: Uint8Array }>(
    "SELECT DISTINCT authority FROM event WHERE role = 'attendee' AND ends_at > ?",
    [now],
  )
  return rows.map((row) => row.authority)
}

export async function listEvents(db: NoteDb, role: EventRole): Promise<StoredEvent[]> {
  const rows = await db.all<Row>(`${SELECT} WHERE role = ? ORDER BY ends_at DESC`, [role])
  return rows.map(eventOf)
}

/** Keeps the pairing a point was given (or an organiser made): it holds the secret, so it never leaves the store. */
export async function savePairing(db: NoteDb, role: 'point' | 'organiser', pairing: PointPairing): Promise<void> {
  await db.run(
    'INSERT OR REPLACE INTO event (event_id, role, authority, name, ends_at, pairing) VALUES (?, ?, ?, ?, ?, ?)',
    [pairing.eventId, role, pairing.authority, pairing.name, pairing.endsAt, encodePairing(pairing)],
  )
}

export async function loadPairing(
  db: NoteDb,
  role: 'point' | 'organiser',
  eventId: Uint8Array,
): Promise<PointPairing | null> {
  const [row] = await db.all<{ pairing: Uint8Array }>('SELECT pairing FROM event WHERE event_id = ? AND role = ?', [
    eventId,
    role,
  ])
  return row ? decodePairing(row.pairing) : null
}

/** The pairing of the point mode that is still running, the one that ends last. */
export async function activePairing(db: NoteDb, now: number): Promise<PointPairing | null> {
  const [row] = await db.all<{ pairing: Uint8Array }>(
    "SELECT pairing FROM event WHERE role = 'point' AND ends_at > ? ORDER BY ends_at DESC LIMIT 1",
    [now],
  )
  return row ? decodePairing(row.pairing) : null
}
