import { equalBytes } from '@noble/curves/utils.js'
import {
  encodeSpendConflict,
  envelope,
  recoverSpendSigner,
  type Received,
  type SpendConflict,
  verifySignature,
  verifySpendConflict,
  walkChain,
} from '../../protocol'
import type { Bundle } from '../../payment/messages'
import type { NoteDb, Statements } from '../notes/db'
import type { PointPairing } from './payloads'

export type ConsumedEntry = { output: Uint8Array; content: Uint8Array; signature: Uint8Array; seenAt: number }

export type PointCheck =
  | { ok: true; entries: ConsumedEntry[] }
  | {
      ok: false
      reason: 'DoubleSpent' | 'NotThisEvent' | 'IssuerNotListed' | 'KeyBlocked'
      conflict?: SpendConflict
    }

type Row = { output_id: Uint8Array; content: Uint8Array; signature: Uint8Array; seen_at: number }

const toEntry = (row: Row): ConsumedEntry => ({
  output: row.output_id,
  content: row.content,
  signature: row.signature,
  seenAt: row.seen_at,
})

export async function recordedEntry(
  db: Statements,
  eventId: Uint8Array,
  output: Uint8Array,
): Promise<ConsumedEntry | null> {
  const [row] = await db.all<Row>(
    'SELECT output_id, content, signature, seen_at FROM event_consumed WHERE event_id = ? AND output_id = ?',
    [eventId, output],
  )
  return row ? toEntry(row) : null
}

/** The conflict two signatures over one output prove, with the key that signed both; null when they are not one key's. */
export function conflictBetween(
  domain: Uint8Array,
  output: Uint8Array,
  a: Pick<ConsumedEntry, 'content' | 'signature'>,
  b: Pick<ConsumedEntry, 'content' | 'signature'>,
): { conflict: SpendConflict; signer: Uint8Array } | null {
  for (let recovery = 0; recovery < 16; recovery++) {
    const conflict: SpendConflict = {
      slot: output,
      contentA: a.content,
      signatureA: a.signature,
      contentB: b.content,
      signatureB: b.signature,
      recovery,
    }
    try {
      const signer = recoverSpendSigner(domain, conflict)
      verifySpendConflict(domain, signer, conflict)
      return { conflict, signer }
    } catch {
      continue
    }
  }
  return null
}

/** Keeps a proven conflict. */
export async function keepConflict(db: Statements, eventId: Uint8Array, conflict: SpendConflict): Promise<void> {
  await db.run('INSERT OR IGNORE INTO event_conflict (event_id, output_id, conflict) VALUES (?, ?, ?)', [
    eventId,
    conflict.slot,
    encodeSpendConflict(conflict),
  ])
}

/** Refuses the key for the rest of the event: two points accepted what it signed twice. */
export async function blockKey(db: Statements, eventId: Uint8Array, key: Uint8Array): Promise<void> {
  await db.run('INSERT OR IGNORE INTO event_blocked (event_id, key) VALUES (?, ?)', [eventId, key])
}

const signedBy = (domain: Uint8Array, signer: Uint8Array, output: Uint8Array, entry: ConsumedEntry) => {
  try {
    verifySignature(signer, envelope(domain, output, entry.content), entry.signature)
    return true
  } catch {
    return false
  }
}

/**
 * Whether this point may accept a payment: it pays the organiser's account from a listed issuer, none of
 * its spenders is blocked (a key is blocked once two points accepted what it signed twice), and no output it consumes was recorded with another content. An entry no key
 * signed never refuses anything: only a signature of the spender can prove a double spend.
 */
export async function checkAtPoint(
  db: NoteDb,
  event: PointPairing,
  noteDomain: Uint8Array,
  received: Received,
  bundle: Bundle,
  now = Math.floor(Date.now() / 1000),
): Promise<PointCheck> {
  const { owner } = received.output
  if (owner.type !== 'account' || !equalBytes(owner.address, event.authority))
    return { ok: false, reason: 'NotThisEvent' }
  if (!event.issuers.some((issuer) => equalBytes(issuer, received.issuer)))
    return { ok: false, reason: 'IssuerNotListed' }
  const walked = walkChain(noteDomain, bundle.issue, bundle.spends)
  for (const { key } of walked.entries.slice(1)) {
    const [blocked] = await db.all('SELECT 1 AS found FROM event_blocked WHERE event_id = ? AND key = ?', [
      event.eventId,
      key,
    ])
    if (blocked) return { ok: false, reason: 'KeyBlocked' }
  }
  const entries: ConsumedEntry[] = []
  for (const [i, consumed] of walked.consumed.entries()) {
    const mine = {
      output: consumed.output,
      content: consumed.content,
      signature: bundle.spends[i].signature,
      seenAt: now,
    }
    const recorded = await recordedEntry(db, event.eventId, consumed.output)
    if (recorded && !equalBytes(recorded.content, mine.content)) {
      const signer = walked.entries[i + 1].key
      const proven = signedBy(noteDomain, signer, consumed.output, recorded)
        ? conflictBetween(noteDomain, consumed.output, recorded, mine)
        : null
      if (proven) {
        await keepConflict(db, event.eventId, proven.conflict)
        return { ok: false, reason: 'DoubleSpent', conflict: proven.conflict }
      }
    }
    entries.push(mine)
  }
  return { ok: true, entries }
}

/** Records what an accepted payment consumed, replacing an entry no key signed. */
export async function recordAtPoint(db: NoteDb, eventId: Uint8Array, entries: ConsumedEntry[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const e of entries) {
      await tx.run(
        'INSERT OR REPLACE INTO event_consumed (event_id, output_id, content, signature, seen_at) VALUES (?, ?, ?, ?, ?)',
        [eventId, e.output, e.content, e.signature, e.seenAt],
      )
    }
  })
}

/** What the point recorded after `since` (seconds), oldest first: what it sends to the other points. */
export async function entriesSince(db: NoteDb, eventId: Uint8Array, since: number): Promise<ConsumedEntry[]> {
  const rows = await db.all<Row>(
    'SELECT output_id, content, signature, seen_at FROM event_consumed WHERE event_id = ? AND seen_at > ? ORDER BY seen_at, output_id',
    [eventId, since],
  )
  return rows.map(toEntry)
}
