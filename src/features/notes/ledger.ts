import { bytesToHex } from '@noble/hashes/utils.js'
import type { NoteDb, Statements } from './db'
import { admit, type Candidate, type Limits, type Liability, type Refusal } from './policy'

export type Claim =
  | {
      kind: 'issue'
      issuer: Uint8Array
      lockSeq: number
      start: bigint
      end: bigint
      content: Uint8Array
      wire: Uint8Array
    }
  | { kind: 'spend'; input: Uint8Array; content: Uint8Array; wire: Uint8Array }

export type ReceivedNote = {
  outputId: Uint8Array
  messageId: Uint8Array
  /** This phone's device key when the note was received. */
  owner: Uint8Array
  mint: Uint8Array
  amount: bigint
  expiry: number
  hopsLeft: number
  caveats: Uint8Array
  issuer: Uint8Array
  lockSeq: number
  bundle: Uint8Array
  liable: Liability[]
  claims: Claim[]
  requestedAmount: bigint | null
  memo: string | null
  transport: string
  receivedAt: number
}

export type Commit = { status: 'accepted' } | { status: 'duplicate' } | { status: 'refused'; reason: Refusal }

async function conflictsOf(tx: Statements, claim: Claim): Promise<Uint8Array | undefined> {
  if (claim.kind === 'issue') {
    const [row] = await tx.all<{ wire: Uint8Array }>(
      'SELECT wire FROM issue_claim WHERE issuer = ? AND lock_seq = ? AND start < ? AND "end" > ? AND content != ? LIMIT 1',
      [claim.issuer, claim.lockSeq, claim.end, claim.start, claim.content],
    )
    return row?.wire
  }
  const [row] = await tx.all<{ wire: Uint8Array }>(
    'SELECT wire FROM spend_claim WHERE input = ? AND content != ? LIMIT 1',
    [claim.input, claim.content],
  )
  return row?.wire
}

async function exposureOf(tx: Statements, liability: Liability): Promise<bigint> {
  const [row] = await tx.all<{ total: number }>(
    `SELECT COALESCE(SUM(n.amount), 0) AS total FROM note_liability l JOIN received_note n ON n.output_id = l.output_id
     WHERE l.device = ? AND l.lock_seq = ? AND n.state IN ('held', 'settling')`,
    [liability.device, liability.lockSeq],
  )
  return BigInt(row.total)
}

/**
 * What the unsettled notes rely on each attester for, as `AttesterLedger.fromJSON` reads it: a note
 * counts once per attester that vouched for any of its locks, while it is `held` or `settling`.
 */
export async function relianceByAttester(db: NoteDb): Promise<Record<string, string>> {
  const rows = await db.all<{ attester: number; total: number }>(
    `SELECT attester, SUM(amount) AS total FROM (
       SELECT DISTINCT l.attester, n.output_id, n.amount FROM note_liability l
       JOIN received_note n ON n.output_id = l.output_id AND n.state IN ('held', 'settling')
     ) GROUP BY attester`,
  )
  return Object.fromEntries(rows.map((row) => [String(row.attester), String(row.total)]))
}

/**
 * Applies the acceptance policy and stores the note, its liabilities and its claims in one
 * transaction. A refused double spend commits its evidence and nothing else.
 */
export async function commitReceived(db: NoteDb, note: ReceivedNote, limits: Limits): Promise<Commit> {
  if (note.amount > BigInt(Number.MAX_SAFE_INTEGER)) return { status: 'refused', reason: 'AboveMax' }
  return db.transaction(async (tx) => {
    const [existing] = await tx.all('SELECT 1 AS found FROM received_note WHERE output_id = ?', [note.outputId])
    if (existing) return { status: 'duplicate' } as const
    let clash: { claim: Claim; wire: Uint8Array } | undefined
    for (const claim of note.claims) {
      const wire = await conflictsOf(tx, claim)
      if (wire) {
        clash = { claim, wire }
        break
      }
    }
    const exposures = new Map<string, bigint>()
    for (const liability of note.liable) {
      exposures.set(`${bytesToHex(liability.device)}:${liability.lockSeq}`, await exposureOf(tx, liability))
    }
    const candidate: Candidate = { amount: note.amount, liable: note.liable }
    const verdict = admit(
      candidate,
      { conflicts: clash !== undefined, exposure: (l) => exposures.get(`${bytesToHex(l.device)}:${l.lockSeq}`) ?? 0n },
      limits,
    )
    if (!verdict.accept) {
      if (clash) {
        await tx.run('INSERT INTO conflict_evidence (kind, refused, existing, seen_at) VALUES (?, ?, ?, ?)', [
          clash.claim.kind,
          clash.claim.wire,
          clash.wire,
          note.receivedAt,
        ])
      }
      return { status: 'refused', reason: verdict.reason } as const
    }
    await tx.run(
      `INSERT INTO received_note (output_id, message_id, owner, mint, amount, expiry, hops_left, caveats, issuer, lock_seq, bundle, state,
         requested_amount, memo, transport, received_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?)`,
      [
        note.outputId,
        note.messageId,
        note.owner,
        note.mint,
        Number(note.amount),
        note.expiry,
        note.hopsLeft,
        note.caveats,
        note.issuer,
        note.lockSeq,
        note.bundle,
        note.requestedAmount === null ? null : Number(note.requestedAmount),
        note.memo,
        note.transport,
        note.receivedAt,
        note.receivedAt,
      ],
    )
    for (const l of note.liable) {
      await tx.run('INSERT INTO note_liability (output_id, device, lock_seq, bond, attester) VALUES (?, ?, ?, ?, ?)', [
        note.outputId,
        l.device,
        l.lockSeq,
        Number(l.bond),
        l.attester,
      ])
    }
    for (const claim of note.claims) {
      if (claim.kind === 'issue') {
        await tx.run(
          'INSERT OR IGNORE INTO issue_claim (issuer, lock_seq, start, "end", content, wire, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            claim.issuer,
            claim.lockSeq,
            Number(claim.start),
            Number(claim.end),
            claim.content,
            claim.wire,
            note.receivedAt,
          ],
        )
      } else {
        await tx.run('INSERT OR IGNORE INTO spend_claim (input, content, wire, seen_at) VALUES (?, ?, ?, ?)', [
          claim.input,
          claim.content,
          claim.wire,
          note.receivedAt,
        ])
      }
    }
    return { status: 'accepted' } as const
  })
}

export type NoteState = 'held' | 'settling' | 'settled' | 'spent' | 'expired' | 'lost' | 'conflicted'

export async function setNoteState(db: NoteDb, outputId: Uint8Array, state: NoteState, now: number): Promise<void> {
  await db.run('UPDATE received_note SET state = ?, updated_at = ? WHERE output_id = ?', [state, now, outputId])
}

/** Before the settlement spend is signed: its body, so a retry signs the same content. The first body written stays. */
export async function prepareSettlement(
  db: NoteDb,
  outputId: Uint8Array,
  body: Uint8Array,
  now: number,
): Promise<void> {
  await db.run(
    "UPDATE received_note SET settlement_body = COALESCE(settlement_body, ?), updated_at = ? WHERE output_id = ? AND state = 'held'",
    [body, now, outputId],
  )
}

/** After signing: the signed spend as it will be sent, and the note is `settling`. The first one written stays. */
export async function markSettlementSigned(
  db: NoteDb,
  outputId: Uint8Array,
  wire: Uint8Array,
  now: number,
): Promise<void> {
  await db.run(
    "UPDATE received_note SET settlement_spend = COALESCE(settlement_spend, ?), state = 'settling', updated_at = ? WHERE output_id = ? AND state IN ('held', 'settling')",
    [wire, now, outputId],
  )
}

export type Settleable = {
  outputId: Uint8Array
  expiry: number
  bundle: Uint8Array
  settlementBody: Uint8Array | null
  settlementSpend: Uint8Array | null
}

/** Notes still to settle (held, or settling without an answer yet) whose window has not closed, soonest expiry first. */
export async function settleable(db: NoteDb, now: number, graceSeconds: number): Promise<Settleable[]> {
  const rows = await db.all<{
    output_id: Uint8Array
    expiry: number
    bundle: Uint8Array
    settlement_body: Uint8Array | null
    settlement_spend: Uint8Array | null
  }>(
    "SELECT output_id, expiry, bundle, settlement_body, settlement_spend FROM received_note WHERE state IN ('held', 'settling') AND expiry + ? > ? ORDER BY expiry, received_at",
    [graceSeconds, now],
  )
  return rows.map((r) => ({
    outputId: r.output_id,
    expiry: r.expiry,
    bundle: r.bundle,
    settlementBody: r.settlement_body,
    settlementSpend: r.settlement_spend,
  }))
}

/** Marks what a key that is no longer this phone's can no longer settle: notes as lost, unfinished payments as abandoned. Idempotent. */
export async function reconcileIdentity(db: NoteDb, currentKey: Uint8Array, now: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run(
      "UPDATE received_note SET state = 'lost', updated_at = ? WHERE owner != ? AND state IN ('held', 'settling')",
      [now, currentKey],
    )
    await tx.run(
      "UPDATE outgoing_payment SET state = 'abandoned', updated_at = ? WHERE device != ? AND state IN ('prepared', 'signed')",
      [now, currentKey],
    )
  })
}

/** Marks the notes whose settlement window closed as expired: the payer may take them back. */
export async function expireUnsettled(db: NoteDb, now: number, graceSeconds: number): Promise<void> {
  await db.run(
    "UPDATE received_note SET state = 'expired', updated_at = ? WHERE state IN ('held', 'settling') AND expiry + ? <= ?",
    [now, graceSeconds, now],
  )
}

/** The chain recorded another content for the output first: the note is lost, and both messages are kept as evidence. */
export async function recordConflict(
  db: NoteDb,
  outputId: Uint8Array,
  refused: Uint8Array,
  recorded: Uint8Array,
  now: number,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.run("UPDATE received_note SET state = 'conflicted', updated_at = ? WHERE output_id = ?", [now, outputId])
    await tx.run("INSERT INTO conflict_evidence (kind, refused, existing, seen_at) VALUES ('spend', ?, ?, ?)", [
      refused,
      recorded,
      now,
    ])
  })
}

export type Unsettled = { count: number; total: bigint; earliestExpiry: number | null }

/** What this phone holds and has not seen settled: its own data, never another person's. */
export async function unsettledSummary(db: NoteDb): Promise<Unsettled> {
  const [row] = await db.all<{ count: number; total: number | null; earliest: number | null }>(
    "SELECT COUNT(*) AS count, SUM(amount) AS total, MIN(expiry) AS earliest FROM received_note WHERE state IN ('held', 'settling')",
  )
  return { count: row.count, total: BigInt(row.total ?? 0), earliestExpiry: row.earliest }
}
