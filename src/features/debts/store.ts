import { equalBytes } from '@noble/curves/utils.js'
import { type CoSignedIou, decodeIou, encodeIou, type Iou } from '../../protocol'
import type { NoteDb, Statements } from '../notes/db'
import { type AppliedNetting, balance, type RepayStatus, TabRefusal, type TabNow } from './tab'

export const DEBTS_SCHEMA_VERSION = 12

/**
 * Moves the note store from version 11 to 12: the tabs two people keep, their co-signed states, and the tables
 * netting sessions and conditional repayments use. They live in the encrypted note store and are not part of any
 * backup: a lost phone loses its tabs (the friend's phone keeps its copy).
 */
export async function migrateDebts(db: NoteDb): Promise<void> {
  const [row] = await db.all<{ user_version: number }>('PRAGMA user_version')
  if (row.user_version >= DEBTS_SCHEMA_VERSION) return
  if (row.user_version !== 11) throw new Error('The note store must be at version 11 before the debts migration')
  await db.exec(`BEGIN;
CREATE TABLE tabs (
  tab BLOB PRIMARY KEY CHECK (length(tab) = 32),
  secret BLOB NOT NULL CHECK (length(secret) = 32),
  peer BLOB NOT NULL CHECK (length(peer) = 33),
  mint BLOB NOT NULL CHECK (length(mint) = 32),
  final_seq INTEGER NOT NULL,
  next_seq INTEGER NOT NULL,
  locked_by BLOB,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX tabs_peer_mint ON tabs (peer, mint);
CREATE TABLE tab_states (
  tab BLOB NOT NULL REFERENCES tabs (tab),
  seq INTEGER NOT NULL,
  body BLOB NOT NULL CHECK (length(body) = 213),
  debtor_sig BLOB,
  creditor_sig BLOB,
  memo TEXT,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (tab, seq)
);
CREATE TABLE netting_sessions (
  session BLOB PRIMARY KEY,
  role INTEGER NOT NULL,
  my_index INTEGER NOT NULL,
  statement BLOB,
  expires INTEGER,
  joins BLOB,
  digests BLOB,
  leaves BLOB,
  ephemeral_secret BLOB,
  signatures BLOB,
  proof BLOB,
  status INTEGER NOT NULL,
  record_tx TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE netting_bases (
  tab BLOB NOT NULL,
  base_seq INTEGER NOT NULL,
  session BLOB NOT NULL REFERENCES netting_sessions (session),
  content BLOB NOT NULL,
  PRIMARY KEY (tab, base_seq, session)
);
CREATE TABLE netting_effects (
  session BLOB NOT NULL REFERENCES netting_sessions (session),
  tab BLOB NOT NULL,
  base_seq INTEGER NOT NULL,
  debtor BLOB NOT NULL,
  cancel INTEGER NOT NULL,
  PRIMARY KEY (session, tab)
);
CREATE TABLE repay_notes (
  tab BLOB NOT NULL,
  seq INTEGER NOT NULL,
  reference BLOB NOT NULL,
  payee BLOB NOT NULL,
  reduction INTEGER NOT NULL,
  request BLOB,
  status INTEGER NOT NULL,
  checked_at INTEGER,
  PRIMARY KEY (tab, reference)
);
CREATE TABLE netting_remainder (
  session BLOB NOT NULL REFERENCES netting_sessions (session),
  tab BLOB NOT NULL,
  message_id BLOB,
  chain BLOB,
  status INTEGER NOT NULL,
  PRIMARY KEY (session, tab)
);
PRAGMA user_version = ${DEBTS_SCHEMA_VERSION};
COMMIT;`)
}

export type TabRow = {
  tab: Uint8Array
  secret: Uint8Array
  peer: Uint8Array
  mint: Uint8Array
  finalSeq: number
  nextSeq: number
  lockedBy: Uint8Array | null
  createdAt: number
}

export type StateRow = {
  iou: Iou
  debtorSig: Uint8Array | null
  creditorSig: Uint8Array | null
  memo: string | null
  recordedAt: number
}

export type Proposal = { iou: Iou; signature: Uint8Array; memo: string | null }

type TabRecord = {
  tab: Uint8Array
  secret: Uint8Array
  peer: Uint8Array
  mint: Uint8Array
  final_seq: number
  next_seq: number
  locked_by: Uint8Array | null
  created_at: number
}

type StateRecord = {
  body: Uint8Array
  debtor_sig: Uint8Array | null
  creditor_sig: Uint8Array | null
  memo: string | null
  recorded_at: number
}

const TAB_COLUMNS = 'tab, secret, peer, mint, final_seq, next_seq, locked_by, created_at'
const STATE_COLUMNS = 'body, debtor_sig, creditor_sig, memo, recorded_at'

const tabRow = (r: TabRecord): TabRow => ({
  tab: r.tab,
  secret: r.secret,
  peer: r.peer,
  mint: r.mint,
  finalSeq: r.final_seq,
  nextSeq: r.next_seq,
  lockedBy: r.locked_by,
  createdAt: r.created_at,
})

const stateRow = (r: StateRecord): StateRow => ({
  iou: decodeIou(r.body),
  debtorSig: r.debtor_sig,
  creditorSig: r.creditor_sig,
  memo: r.memo,
  recordedAt: r.recorded_at,
})

const coSigned = (row: StateRow): CoSignedIou | null =>
  row.debtorSig && row.creditorSig ? { iou: row.iou, debtorSig: row.debtorSig, creditorSig: row.creditorSig } : null

async function tabOf(db: Statements, tab: Uint8Array): Promise<TabRecord> {
  const [row] = await db.all<TabRecord>(`SELECT ${TAB_COLUMNS} FROM tabs WHERE tab = ?`, [tab])
  if (!row) throw new TabRefusal('other-tab')
  return row
}

/** The tab of `t.tab`, created with `final_seq` 0 and `next_seq` 1 if it is new; one tab per peer and mint. */
export async function openTab(
  db: NoteDb,
  t: { tab: Uint8Array; secret: Uint8Array; peer: Uint8Array; mint: Uint8Array },
  now: number,
): Promise<TabRow> {
  return db.transaction(async (tx) => {
    const [same] = await tx.all<TabRecord>(`SELECT ${TAB_COLUMNS} FROM tabs WHERE tab = ? OR (peer = ? AND mint = ?)`, [
      t.tab,
      t.peer,
      t.mint,
    ])
    if (same) {
      if (equalBytes(same.tab, t.tab) && equalBytes(same.peer, t.peer) && equalBytes(same.mint, t.mint))
        return tabRow(same)
      throw new TabRefusal('other-tab')
    }
    await tx.run(
      'INSERT INTO tabs (tab, secret, peer, mint, final_seq, next_seq, locked_by, created_at) VALUES (?, ?, ?, ?, 0, 1, NULL, ?)',
      [t.tab, t.secret, t.peer, t.mint, now],
    )
    return tabRow(await tabOf(tx, t.tab))
  })
}

/** Every tab with its latest co-signed state and its pending proposal, newest activity first. */
export async function listTabs(
  db: NoteDb,
): Promise<{ row: TabRow; latest: CoSignedIou | null; pending: StateRow | null }[]> {
  const rows = await db.all<TabRecord>(
    `SELECT ${TAB_COLUMNS} FROM tabs ORDER BY coalesce((SELECT max(recorded_at) FROM tab_states s WHERE s.tab = tabs.tab), created_at) DESC, created_at DESC`,
  )
  return Promise.all(
    rows.map(async (record) => ({
      row: tabRow(record),
      latest: await latestFinal(db, record.tab),
      pending: await pendingProposal(db, record.tab),
    })),
  )
}

export async function tabWith(db: NoteDb, peer: Uint8Array, mint: Uint8Array): Promise<TabRow | null> {
  const [row] = await db.all<TabRecord>(`SELECT ${TAB_COLUMNS} FROM tabs WHERE peer = ? AND mint = ?`, [peer, mint])
  return row ? tabRow(row) : null
}

/** The tab with this id, whoever it is with. */
export async function tabById(db: NoteDb, tab: Uint8Array): Promise<TabRow | null> {
  const [row] = await db.all<TabRecord>(`SELECT ${TAB_COLUMNS} FROM tabs WHERE tab = ?`, [tab])
  return row ? tabRow(row) : null
}

export async function tabSecret(db: NoteDb, tab: Uint8Array): Promise<Uint8Array> {
  return (await tabOf(db, tab)).secret
}

/** The co-signed state at the tab's `final_seq`, or `null` before the first. */
export async function latestFinal(db: NoteDb, tab: Uint8Array): Promise<CoSignedIou | null> {
  const [row] = await db.all<StateRecord>(
    `SELECT ${STATE_COLUMNS} FROM tab_states WHERE tab = ? AND seq = (SELECT final_seq FROM tabs WHERE tab = ?)`,
    [tab, tab],
  )
  return row ? coSigned(stateRow(row)) : null
}

/** Every state of the tab, one-sided ones included, `seq` descending. */
export async function statesOf(db: NoteDb, tab: Uint8Array): Promise<StateRow[]> {
  const rows = await db.all<StateRecord>(`SELECT ${STATE_COLUMNS} FROM tab_states WHERE tab = ? ORDER BY seq DESC`, [
    tab,
  ])
  return rows.map(stateRow)
}

/** Every co-signed state, `seq` ascending: the union of what both phones exchanged, and the only input of the balance. */
export async function coSignedStates(db: NoteDb, tab: Uint8Array): Promise<CoSignedIou[]> {
  const rows = await db.all<StateRecord>(
    `SELECT ${STATE_COLUMNS} FROM tab_states WHERE tab = ? AND debtor_sig IS NOT NULL AND creditor_sig IS NOT NULL ORDER BY seq ASC`,
    [tab],
  )
  return rows.map((row) => coSigned(stateRow(row))!)
}

/** The one-sided state at `next_seq - 1`; taking a newer `seq` leaves an older offer in the table but no longer pending. */
export async function pendingProposal(db: NoteDb, tab: Uint8Array): Promise<StateRow | null> {
  const [row] = await db.all<StateRecord>(
    `SELECT ${STATE_COLUMNS} FROM tab_states WHERE tab = ? AND seq = (SELECT next_seq - 1 FROM tabs WHERE tab = ?) AND seq > (SELECT final_seq FROM tabs WHERE tab = ?) AND (debtor_sig IS NULL OR creditor_sig IS NULL)`,
    [tab, tab, tab],
  )
  return row ? stateRow(row) : null
}

/** The `seq` to sign next. It is stored before anything is signed, so a crash or a decline burns it and never the tab. */
export async function takeNextSeq(db: NoteDb, tab: Uint8Array): Promise<number> {
  return db.transaction(async (tx) => {
    const row = await tabOf(tx, tab)
    if (row.locked_by) throw new TabRefusal('locked')
    await tx.run('UPDATE tabs SET next_seq = next_seq + 1 WHERE tab = ?', [tab])
    return row.next_seq
  })
}

/** For the answerer: `next_seq` becomes at least `atLeast + 1`, before it signs the offered `seq`. */
export async function reserveSeq(db: NoteDb, tab: Uint8Array, atLeast: number): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await tabOf(tx, tab)
    if (row.locked_by) throw new TabRefusal('locked')
    await tx.run('UPDATE tabs SET next_seq = max(next_seq, ?) WHERE tab = ?', [atLeast + 1, tab])
  })
}

/** Keeps the state this phone signed and offered, with only its own signature; it never touches `final_seq`. */
export async function saveProposal(db: NoteDb, state: Proposal, now: number): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await tabOf(tx, state.iou.tab)
    const column = equalBytes(state.iou.debtor, row.peer) ? 'creditor_sig' : 'debtor_sig'
    await tx.run(
      `INSERT OR IGNORE INTO tab_states (tab, seq, body, ${column}, memo, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [state.iou.tab, state.iou.seq, encodeIou(state.iou), state.signature, state.memo, now],
    )
  })
}

/**
 * Keeps a co-signed state. A different body at the same `seq` is refused (`malformed`) and nothing is written;
 * `final_seq` only grows, so a replayed old state changes nothing but its own row.
 */
export async function saveCoSigned(
  db: NoteDb,
  state: CoSignedIou,
  now: number,
  memo: string | null = null,
): Promise<void> {
  await db.transaction((tx) => writeCoSigned(tx, state, now, memo))
}

/** A co-signed Repay and the note that follows its payment, in one transaction: either both exist or neither. */
export async function saveCoSignedRepay(
  db: NoteDb,
  state: CoSignedIou,
  note: RepayNoteRow,
  now: number,
  memo: string | null = null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await writeCoSigned(tx, state, now, memo)
    await writeRepayNote(tx, note)
  })
}

async function writeCoSigned(tx: Statements, state: CoSignedIou, now: number, memo: string | null): Promise<void> {
  const body = encodeIou(state.iou)
  await tabOf(tx, state.iou.tab)
  const [held] = await tx.all<{ body: Uint8Array }>('SELECT body FROM tab_states WHERE tab = ? AND seq = ?', [
    state.iou.tab,
    state.iou.seq,
  ])
  if (held && !equalBytes(held.body, body)) throw new TabRefusal('malformed')
  await tx.run(
    `INSERT INTO tab_states (tab, seq, body, debtor_sig, creditor_sig, memo, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tab, seq) DO UPDATE SET debtor_sig = excluded.debtor_sig, creditor_sig = excluded.creditor_sig, memo = coalesce(excluded.memo, memo)`,
    [state.iou.tab, state.iou.seq, body, state.debtorSig, state.creditorSig, memo, now],
  )
  await tx.run('UPDATE tabs SET final_seq = max(final_seq, ?), next_seq = max(next_seq, ?) WHERE tab = ?', [
    state.iou.seq,
    state.iou.seq + 1,
    state.iou.tab,
  ])
}

/** Locks every tab for a netting session, all or nothing; a tab locked by another session refuses. */
export async function lockTabs(db: NoteDb, session: Uint8Array, tabs: readonly Uint8Array[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const tab of tabs) {
      const row = await tabOf(tx, tab)
      if (row.locked_by && !equalBytes(row.locked_by, session)) throw new TabRefusal('locked')
    }
    for (const tab of tabs) await tx.run('UPDATE tabs SET locked_by = ? WHERE tab = ?', [session, tab])
  })
}

export async function unlockTabs(db: NoteDb, session: Uint8Array): Promise<void> {
  await db.run('UPDATE tabs SET locked_by = NULL WHERE locked_by = ?', [session])
}

export type RepayNoteRow = {
  tab: Uint8Array
  seq: number
  reference: Uint8Array
  payee: Uint8Array
  reduction: bigint
  request: Uint8Array | null
}

const REPAY_STATUS: Record<RepayStatus['status'], number> = {
  settling: 0,
  settled: 1,
  void: 3,
  unknown: 4,
  undecided: 5,
}
const REPAY_STATUS_NAME = new Map(
  Object.entries(REPAY_STATUS).map(([name, code]) => [code, name as RepayStatus['status']]),
)

/** Records the conditional repayment of a co-signed Repay, settling; one row per `(tab, reference)`. */
export async function saveRepayNote(db: NoteDb, row: RepayNoteRow): Promise<void> {
  await writeRepayNote(db, row)
}

const writeRepayNote = (db: Statements, row: RepayNoteRow) =>
  db.run(
    'INSERT OR IGNORE INTO repay_notes (tab, seq, reference, payee, reduction, request, status, checked_at) VALUES (?, ?, ?, ?, ?, ?, 0, NULL)',
    [row.tab, row.seq, row.reference, row.payee, row.reduction, row.request],
  )

/**
 * Moves a repayment to an outcome. `void` is final: a first void read leaves the row settling with `checkedAt`
 * set, and only a confirming read writes `void`.
 */
export async function setRepayStatus(
  db: NoteDb,
  tab: Uint8Array,
  reference: Uint8Array,
  status: RepayStatus['status'],
  checkedAt: number,
): Promise<void> {
  await db.run('UPDATE repay_notes SET status = ?, checked_at = ? WHERE tab = ? AND reference = ?', [
    REPAY_STATUS[status],
    checkedAt,
    tab,
    reference,
  ])
}

export async function repayStatuses(db: NoteDb, tab: Uint8Array): Promise<RepayStatus[]> {
  const rows = await db.all<{
    tab: Uint8Array
    seq: number
    reference: Uint8Array
    payee: Uint8Array
    reduction: number | bigint
    status: number
  }>('SELECT tab, seq, reference, payee, reduction, status FROM repay_notes WHERE tab = ? ORDER BY seq', [tab])
  return rows.map((row) => {
    const status = REPAY_STATUS_NAME.get(row.status)
    if (!status) throw new Error(`Unknown repayment status ${row.status}`)
    return {
      tab: row.tab,
      seq: row.seq,
      reference: row.reference,
      payee: row.payee,
      reduction: BigInt(row.reduction),
      status,
    }
  })
}

/** The nettings of the tab whose record landed (session status 4, set from a chain read only). */
export async function appliedNettings(db: NoteDb, tab: Uint8Array): Promise<AppliedNetting[]> {
  const rows = await db.all<{
    tab: Uint8Array
    base_seq: number
    debtor: Uint8Array
    cancel: number | bigint
    content: Uint8Array
  }>(
    `SELECT e.tab, e.base_seq, e.debtor, e.cancel, b.content
     FROM netting_effects e
     JOIN netting_sessions s ON s.session = e.session
     JOIN netting_bases b ON b.tab = e.tab AND b.base_seq = e.base_seq AND b.session = e.session
     WHERE e.tab = ? AND s.status = 4`,
    [tab],
  )
  return rows.map((row) => ({
    content: row.content,
    tab: row.tab,
    baseSeq: row.base_seq,
    debtor: row.debtor,
    cancel: BigInt(row.cancel),
  }))
}

/** The balance seen from `me` and whether a repayment or netting still undecided holds back "clear". */
export async function tabNow(db: NoteDb, me: Uint8Array, tab: Uint8Array): Promise<TabNow> {
  const [states, nettings, repays] = [
    await coSignedStates(db, tab),
    await appliedNettings(db, tab),
    await repayStatuses(db, tab),
  ]
  const [{ pending }] = await db.all<{ pending: number }>(
    `SELECT (
       EXISTS (SELECT 1 FROM repay_notes WHERE tab = ? AND status IN (0, 4, 5))
       OR EXISTS (SELECT 1 FROM netting_effects e JOIN netting_sessions s ON s.session = e.session WHERE e.tab = ? AND s.status IN (2, 3, 7))
     ) AS pending`,
    [tab, tab],
  )
  return { balance: balance(me, states, nettings, repays), pending: pending === 1 }
}

/** The nettings of the tab that were recorded, with the time this phone read their record. */
export async function recordedNettings(db: NoteDb, tab: Uint8Array): Promise<{ cancel: bigint; recordedAt: number }[]> {
  const rows = await db.all<{ cancel: number | bigint; updated_at: number }>(
    `SELECT e.cancel, s.updated_at FROM netting_effects e JOIN netting_sessions s ON s.session = e.session
     WHERE e.tab = ? AND s.status = 4 ORDER BY s.updated_at DESC`,
    [tab],
  )
  return rows.map((row) => ({ cancel: BigInt(row.cancel), recordedAt: row.updated_at }))
}
