import { equalBytes } from '@noble/curves/utils.js'
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js'
import { decodeStatement, type NettingStatement, ProtocolError, statementContent } from '../../protocol'
import { appliedNettings, coSignedStates, listTabs, repayStatuses } from '../debts/store'
import { balance } from '../debts/tab'
import type { NoteDb, Statements } from '../notes/db'
import { toBytes32 } from '../rewards/secrets-poseidon'
import type { Slot } from './digest'
import { checkFinal, type FinalCheck, type MyTab, type MyTabs, NettingRefusal, type SessionDomains } from './member'
import { decodeMessage, encodeMessage, type SignedRosterEntry } from './messages'

export const Status = {
  Joining: 0,
  Proposed: 1,
  Approved: 2,
  Agreed: 3,
  Recorded: 4,
  Void: 5,
  Abandoned: 6,
  Undecided: 7,
} as const
export const Role = { Host: 0, Member: 1 } as const

export class SessionExists extends Error {
  constructor() {
    super('This session already exists.')
    this.name = 'SessionExists'
  }
}

/** The base of a tab is signed by another session, or by this one with another content. */
export class BaseTaken extends Error {
  constructor() {
    super('This tab state is already part of another netting.')
    this.name = 'BaseTaken'
  }
}

export type SessionRow = {
  session: Uint8Array
  role: 0 | 1
  myIndex: number
  statement: Uint8Array | null
  expires: number | null
  joins: SignedRosterEntry[]
  digests: Uint8Array[]
  leaves: Slot[]
  signatures: Uint8Array[]
  proof: Uint8Array | null
  status: number
  recordTx: string | null
  createdAt: number
  updatedAt: number
}

type SessionRecord = {
  session: Uint8Array
  role: number
  my_index: number
  statement: Uint8Array | null
  expires: number | null
  joins: Uint8Array | null
  digests: Uint8Array | null
  leaves: Uint8Array | null
  signatures: Uint8Array | null
  proof: Uint8Array | null
  status: number
  record_tx: string | null
  created_at: number
  updated_at: number
}

const COLUMNS =
  'session, role, my_index, statement, expires, joins, digests, leaves, signatures, proof, status, record_tx, created_at, updated_at'
const SIGNATURE_LEN = 64
const LEAF_LEN = 85
const IN_FLIGHT = '(2, 3, 7)'

function encodeLeaves(leaves: readonly Slot[]): Uint8Array {
  return concatBytes(
    ...leaves.map((slot) => {
      const out = new Uint8Array(LEAF_LEN)
      const view = new DataView(out.buffer)
      out.set(slot.tab, 0)
      view.setUint32(32, slot.seq, true)
      out[36] = slot.dir
      view.setBigUint64(37, slot.debt, true)
      view.setBigUint64(45, slot.cancel, true)
      out.set(toBytes32(slot.salt), 53)
      return out
    }),
  )
}

function decodeLeaves(bytes: Uint8Array | null): Slot[] {
  if (!bytes) return []
  return Array.from({ length: bytes.length / LEAF_LEN }, (_, k) => {
    const at = k * LEAF_LEN
    const view = new DataView(bytes.buffer, bytes.byteOffset + at, LEAF_LEN)
    return {
      tab: bytes.slice(at, at + 32),
      seq: view.getUint32(32, true),
      dir: bytes[at + 36] as 0 | 1,
      debt: view.getBigUint64(37, true),
      cancel: view.getBigUint64(45, true),
      salt: BigInt(`0x${bytesToHex(bytes.slice(at + 53, at + 85))}`),
    }
  })
}

const encodeSignatures = (signatures: readonly Uint8Array[]) =>
  concatBytes(Uint8Array.of(signatures.length), ...signatures)

function decodeSignatures(bytes: Uint8Array | null): Uint8Array[] {
  if (!bytes || bytes.length === 0) return []
  return Array.from({ length: bytes[0] }, (_, i) => bytes.slice(1 + i * SIGNATURE_LEN, 1 + (i + 1) * SIGNATURE_LEN))
}

const rowOf = (r: SessionRecord): SessionRow => ({
  session: r.session,
  role: r.role as 0 | 1,
  myIndex: r.my_index,
  statement: r.statement,
  expires: r.expires,
  joins: r.joins ? (decodeMessage(0x11, r.joins) as { entries: SignedRosterEntry[] }).entries : [],
  digests: r.digests
    ? Array.from({ length: r.digests.length / 32 }, (_, i) => r.digests!.slice(i * 32, i * 32 + 32))
    : [],
  leaves: decodeLeaves(r.leaves),
  signatures: decodeSignatures(r.signatures),
  proof: r.proof,
  status: r.status,
  recordTx: r.record_tx,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

async function recordOf(db: Statements, session: Uint8Array): Promise<SessionRecord | undefined> {
  const [record] = await db.all<SessionRecord>(`SELECT ${COLUMNS} FROM netting_sessions WHERE session = ?`, [session])
  return record
}

export async function createSession(
  db: NoteDb,
  row: { session: Uint8Array; role: 0 | 1; myIndex: number; ephemeralSecret: Uint8Array; now: number },
): Promise<void> {
  await db.transaction(async (tx) => {
    if (await recordOf(tx, row.session)) throw new SessionExists()
    await tx.run(
      'INSERT INTO netting_sessions (session, role, my_index, ephemeral_secret, status, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      [row.session, row.role, row.myIndex, row.ephemeralSecret, row.now, row.now],
    )
  })
}

export async function loadSession(db: NoteDb, session: Uint8Array): Promise<SessionRow | undefined> {
  const record = await recordOf(db, session)
  return record && rowOf(record)
}

export async function listSessions(db: NoteDb, limit: number): Promise<SessionRow[]> {
  const records = await db.all<SessionRecord>(
    `SELECT ${COLUMNS} FROM netting_sessions ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    [limit],
  )
  return records.map(rowOf)
}

export async function ephemeralSecretOf(db: NoteDb, session: Uint8Array): Promise<Uint8Array | null> {
  const [row] = await db.all<{ ephemeral_secret: Uint8Array | null }>(
    'SELECT ephemeral_secret FROM netting_sessions WHERE session = ?',
    [session],
  )
  return row?.ephemeral_secret ?? null
}

export async function markProposed(
  db: NoteDb,
  session: Uint8Array,
  p: {
    statement: Uint8Array
    joins: SignedRosterEntry[]
    digests: Uint8Array[]
    leaves: Slot[]
    myIndex: number
    now: number
  },
): Promise<void> {
  const expires = decodeStatement(p.statement).expires
  await db.run(
    `UPDATE netting_sessions SET statement = ?, expires = ?, joins = ?, digests = ?, leaves = ?, my_index = ?, status = 1, updated_at = ?
     WHERE session = ? AND status = 0`,
    [
      p.statement,
      expires,
      encodeMessage({ type: 'Roster', entries: p.joins }).body,
      concatBytes(...p.digests),
      encodeLeaves(p.leaves),
      p.myIndex,
      p.now,
      session,
    ],
  )
}

export type Effect = { tab: Uint8Array; baseSeq: number; debtor: Uint8Array; cancel: bigint }

/**
 * One transaction: the bases this session signs (a base held by another session in flight, or by this one with
 * another content, throws `BaseTaken` and nothing is written), their effects, status 2, my signature, and the end of
 * the consent lock. Written before `Approve` leaves the phone.
 */
export async function markApproved(
  db: NoteDb,
  session: Uint8Array,
  content: Uint8Array,
  effects: readonly Effect[],
  mySignature: Uint8Array,
  now: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    const record = await recordOf(tx, session)
    if (!record) throw new NettingRefusal('BadStatement')
    for (const effect of effects) {
      const held = await tx.all<{ session: Uint8Array; content: Uint8Array; status: number }>(
        `SELECT b.session, b.content, s.status FROM netting_bases b JOIN netting_sessions s ON s.session = b.session
         WHERE b.tab = ? AND b.base_seq = ?`,
        [effect.tab, effect.baseSeq],
      )
      for (const other of held) {
        const mine = equalBytes(other.session, session)
        if (mine ? !equalBytes(other.content, content) : [2, 3, 7].includes(other.status)) throw new BaseTaken()
      }
    }
    for (const effect of effects) {
      await tx.run('INSERT OR IGNORE INTO netting_bases (tab, base_seq, session, content) VALUES (?, ?, ?, ?)', [
        effect.tab,
        effect.baseSeq,
        session,
        content,
      ])
      await tx.run(
        'INSERT OR IGNORE INTO netting_effects (session, tab, base_seq, debtor, cancel) VALUES (?, ?, ?, ?, ?)',
        [session, effect.tab, effect.baseSeq, effect.debtor, effect.cancel],
      )
    }
    const known = decodeSignatures(record.signatures)
    const size = Math.max(
      known.length,
      record.statement ? decodeStatement(record.statement).participants : 0,
      record.my_index + 1,
    )
    const signatures = Array.from({ length: size }, (_, i) =>
      i === record.my_index ? mySignature : (known[i] ?? new Uint8Array(SIGNATURE_LEN)),
    )
    await tx.run('UPDATE netting_sessions SET signatures = ?, status = 2, updated_at = ? WHERE session = ?', [
      encodeSignatures(signatures),
      now,
      session,
    ])
    await tx.run('UPDATE tabs SET locked_by = NULL WHERE locked_by = ?', [session])
  })
}

export type FinalDeps = {
  domains: SessionDomains
  now: () => number
  verify: (statement: NettingStatement, proof: Uint8Array) => Promise<boolean>
}

const wipe = (tx: Statements, session: Uint8Array) =>
  tx.run('UPDATE netting_sessions SET ephemeral_secret = NULL WHERE session = ?', [session])

/**
 * With a full set: verifies it, stores it, status 2 to 3 (agreed) and wipes the ephemeral secret; idempotent, and a
 * session the chain already decided is not changed. With `{ recorded: true }` the caller holds a chain read saying
 * the record landed: status 2 or 3 to 4.
 */
export async function adoptFinal(
  db: NoteDb,
  deps: FinalDeps,
  session: Uint8Array,
  statement: Uint8Array,
  evidence: { signatures: Uint8Array[]; proof: Uint8Array } | { recorded: true },
): Promise<FinalCheck> {
  let decoded: NettingStatement
  try {
    decoded = decodeStatement(statement)
  } catch (error) {
    if (error instanceof ProtocolError) throw new NettingRefusal('BadStatement')
    throw error
  }
  const record = await recordOf(db, session)
  if (
    !record?.statement ||
    !equalBytes(statementContent(decodeStatement(record.statement)), statementContent(decoded))
  ) {
    throw new NettingRefusal('BadStatement')
  }
  if ('recorded' in evidence) {
    if (record.status === Status.Approved || record.status === Status.Agreed) {
      await db.transaction(async (tx) => {
        await tx.run('UPDATE netting_sessions SET status = 4, updated_at = ? WHERE session = ?', [deps.now(), session])
        await wipe(tx, session)
      })
    }
    return { setComplete: true, proof: 'valid' }
  }
  const check = await checkFinal(decoded, evidence.signatures, evidence.proof, {
    domains: deps.domains,
    verifyProof: deps.verify,
  })
  if (record.status === Status.Approved) {
    await db.transaction(async (tx) => {
      await tx.run(
        'UPDATE netting_sessions SET signatures = ?, proof = ?, status = 3, updated_at = ? WHERE session = ? AND status = 2',
        [encodeSignatures(evidence.signatures), evidence.proof, deps.now(), session],
      )
      await wipe(tx, session)
    })
  }
  return check
}

export type Quote = { quoteId?: string; lamports: bigint | number; sponsor: string; expiresAt: number }

/** What the record needs from the network; the screen binds the wallet and the gateway. */
export type RecordPorts = {
  submitNetting(
    statement: Uint8Array,
    signatures: Uint8Array[],
    proof: Uint8Array,
    payment?: string,
  ): Promise<{ signature: string; pending: boolean } | { recorded: true } | { capped: true }>
  quoteNettingRecord(): Promise<Quote>
  payNettingRecord(content: Uint8Array, quote: Quote): Promise<string>
  recordNettingPaying(
    statement: Uint8Array,
    signatures: Uint8Array[],
    proof: Uint8Array,
  ): Promise<{ signature: string }>
}

/**
 * For an agreed session: the free lane, then `needs-fee` (the screen asks for the paid lane), then `member-paid`.
 * A response never sets status 4: only a chain read does.
 */
export async function pursueRecord(
  db: NoteDb,
  choice: { payFee?: boolean },
  session: Uint8Array,
  ports: RecordPorts,
): Promise<{ step: 'submitted' } | { step: 'needs-fee'; quote: Quote } | { step: 'member-paid' }> {
  const row = await loadSession(db, session)
  if (row?.status !== Status.Agreed || !row.statement || !row.proof) throw new Error('The session is not agreed.')
  const { statement, signatures, proof } = row
  const free = await ports.submitNetting(statement, signatures, proof)
  if (!('capped' in free)) return { step: 'submitted' }
  const quote = await ports.quoteNettingRecord()
  if (!choice.payFee) return { step: 'needs-fee', quote }
  const payment = await ports.payNettingRecord(statementContent(decodeStatement(statement)), quote)
  const paid = await ports.submitNetting(statement, signatures, proof, payment)
  if (!('capped' in paid)) return { step: 'submitted' }
  await ports.recordNettingPaying(statement, signatures, proof)
  return { step: 'member-paid' }
}

export type SweepCounts = { recorded: number; voided: number; undecided: number; abandoned: number }

/**
 * Chain reads only: recorded to 4, void to 5, undecided to 7, pending unchanged. The clock never voids a session
 * that holds a signature. Sessions still joining or proposed signed nothing, so a restart (or their expiry)
 * abandons them and ends their lock.
 */
export async function sweepSessions(
  db: NoteDb,
  deps: { nettingOutcome: (statement: NettingStatement) => Promise<'recorded' | 'void' | 'pending' | 'undecided'> },
  now: number,
  options: { restart: boolean },
): Promise<SweepCounts> {
  const counts: SweepCounts = { recorded: 0, voided: 0, undecided: 0, abandoned: 0 }
  const rows = await db.all<{
    session: Uint8Array
    status: number
    statement: Uint8Array | null
    expires: number | null
  }>('SELECT session, status, statement, expires FROM netting_sessions WHERE status IN (0, 1, 2, 3, 7)')
  for (const row of rows) {
    if (row.status <= Status.Proposed) {
      if (options.restart || (row.expires !== null && now >= row.expires)) {
        await db.transaction(async (tx) => {
          await tx.run('UPDATE netting_sessions SET status = 6, updated_at = ? WHERE session = ?', [now, row.session])
          await wipe(tx, row.session)
          await tx.run('UPDATE tabs SET locked_by = NULL WHERE locked_by = ?', [row.session])
        })
        counts.abandoned++
      }
      continue
    }
    if (!row.statement) continue
    const outcome = await deps.nettingOutcome(decodeStatement(row.statement))
    const next = { recorded: Status.Recorded, void: Status.Void, undecided: Status.Undecided, pending: null }[outcome]
    if (next === null || next === row.status) continue
    await db.transaction(async (tx) => {
      await tx.run('UPDATE netting_sessions SET status = ?, updated_at = ? WHERE session = ?', [next, now, row.session])
      if (next !== Status.Undecided) await wipe(tx, row.session)
    })
    if (next === Status.Recorded) counts.recorded++
    else if (next === Status.Void) counts.voided++
    else counts.undecided++
  }
  return counts
}

/** An agreed netting (status 2, 3 or 7) or a repayment still settling, unknown or undecided holds the tab. */
export async function nettingPending(db: NoteDb, tab: Uint8Array): Promise<boolean> {
  const [{ pending }] = await db.all<{ pending: number }>(
    `SELECT (
       EXISTS (SELECT 1 FROM repay_notes WHERE tab = ? AND status IN (0, 4, 5))
       OR EXISTS (SELECT 1 FROM netting_effects e JOIN netting_sessions s ON s.session = e.session WHERE e.tab = ? AND s.status IN ${IN_FLIGHT})
     ) AS pending`,
    [tab, tab],
  )
  return pending === 1
}

/**
 * The member's tabs for a statement of `mint`, with the balance from every co-signed change plus the recorded
 * nettings and settled repayments, and the bases other sessions in flight hold.
 */
export async function mineFrom(
  db: NoteDb,
  who: { index: number; session: Uint8Array; mint: Uint8Array; deviceKey: Uint8Array; ephemeral: Uint8Array },
): Promise<MyTabs> {
  const tabs: MyTab[] = []
  for (const { row, latest } of await listTabs(db)) {
    if (!latest || !equalBytes(row.mint, who.mint)) continue
    const value = balance(
      who.deviceKey,
      await coSignedStates(db, row.tab),
      await appliedNettings(db, row.tab),
      await repayStatuses(db, row.tab),
    )
    if (value === 0n) continue
    tabs.push({
      tab: row.tab,
      peer: row.peer,
      secret: row.secret,
      finalSeq: row.finalSeq,
      balance: value,
      pending: await nettingPending(db, row.tab),
      due: latest.iou.due,
      state: latest,
    })
  }
  const bases = await db.all<{ tab: Uint8Array; base_seq: number; session: Uint8Array }>(
    `SELECT b.tab, b.base_seq, b.session FROM netting_bases b JOIN netting_sessions s ON s.session = b.session
     WHERE s.status IN ${IN_FLIGHT}`,
  )
  return {
    ...who,
    tabs,
    signedBases: new Map(bases.map((b) => [`${bytesToHex(b.tab)}:${b.base_seq}`, bytesToHex(b.session)])),
  }
}
