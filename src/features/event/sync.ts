import { equalBytes } from '@noble/curves/utils.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import type { SpendConflict } from '../../protocol'
import type { NoteDb } from '../notes/db'
import { blockKey, type ConsumedEntry, conflictBetween, keepConflict, recordedEntry } from './consumed'
import type { PointPairing } from './payloads'

const VERSION = 1
const ID_BYTES = 16
const ENTRY_BYTES = 32 + 32 + 64 + 4
const HEADER_BYTES = 1 + ID_BYTES + ID_BYTES + 2
const MAC_BYTES = 32

/** The most entries one sync message carries: it fits one transport message. */
export const MAX_SYNC_ENTRIES = 60

export type SyncMessage = { eventId: Uint8Array; from: Uint8Array; entries: ConsumedEntry[] }

const mac = (secret: Uint8Array, body: Uint8Array) => hmac(sha256, secret, body)

/** A message from one point to the others: its entries, authenticated under the event secret. */
export function encodeSync(secret: Uint8Array, message: SyncMessage): Uint8Array {
  const { eventId, from, entries } = message
  if (eventId.length !== ID_BYTES || from.length !== ID_BYTES) throw new RangeError('ids are 16 bytes')
  if (entries.length > MAX_SYNC_ENTRIES)
    throw new RangeError(`a sync message carries at most ${MAX_SYNC_ENTRIES} entries`)
  const body = new Uint8Array(HEADER_BYTES + ENTRY_BYTES * entries.length)
  const view = new DataView(body.buffer)
  body[0] = VERSION
  body.set(eventId, 1)
  body.set(from, 1 + ID_BYTES)
  view.setUint16(1 + 2 * ID_BYTES, entries.length)
  entries.forEach((entry, i) => {
    const at = HEADER_BYTES + i * ENTRY_BYTES
    body.set(entry.output, at)
    body.set(entry.content, at + 32)
    body.set(entry.signature, at + 64)
    view.setUint32(at + 128, entry.seenAt)
  })
  return concatBytes(body, mac(secret, body))
}

/** The message, or null when it is not for this event's secret, is altered or is malformed. */
export function decodeSync(secret: Uint8Array, wire: Uint8Array): SyncMessage | null {
  if (wire.length < HEADER_BYTES + MAC_BYTES || wire[0] !== VERSION) return null
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
  const count = view.getUint16(1 + 2 * ID_BYTES)
  const bodyLength = HEADER_BYTES + ENTRY_BYTES * count
  if (count > MAX_SYNC_ENTRIES || wire.length !== bodyLength + MAC_BYTES) return null
  const body = wire.subarray(0, bodyLength)
  if (!equalBytes(wire.subarray(bodyLength), mac(secret, body))) return null
  const entries = Array.from({ length: count }, (_, i): ConsumedEntry => {
    const at = HEADER_BYTES + i * ENTRY_BYTES
    return {
      output: wire.slice(at, at + 32),
      content: wire.slice(at + 32, at + 64),
      signature: wire.slice(at + 64, at + 128),
      seenAt: view.getUint32(at + 128),
    }
  })
  return { eventId: wire.slice(1, 1 + ID_BYTES), from: wire.slice(1 + ID_BYTES, 1 + 2 * ID_BYTES), entries }
}

/** Merges what another point recorded; a content that differs from ours for an output is a conflict when one key signed both. */
export async function applySync(
  db: NoteDb,
  event: PointPairing,
  noteDomain: Uint8Array,
  entries: ConsumedEntry[],
): Promise<{ added: number; conflicts: SpendConflict[] }> {
  return db.transaction(async (tx) => {
    let added = 0
    const conflicts: SpendConflict[] = []
    for (const entry of entries) {
      const recorded = await recordedEntry(tx, event.eventId, entry.output)
      if (!recorded) {
        await tx.run(
          'INSERT INTO event_consumed (event_id, output_id, content, signature, seen_at) VALUES (?, ?, ?, ?, ?)',
          [event.eventId, entry.output, entry.content, entry.signature, entry.seenAt],
        )
        added++
      } else if (!equalBytes(recorded.content, entry.content)) {
        const proven = conflictBetween(noteDomain, entry.output, recorded, entry)
        if (proven) {
          const [kept] = await tx.all('SELECT 1 AS found FROM event_conflict WHERE event_id = ? AND output_id = ?', [
            event.eventId,
            entry.output,
          ])
          await keepConflict(tx, event.eventId, proven.conflict)
          await blockKey(tx, event.eventId, proven.signer)
          if (!kept) conflicts.push(proven.conflict)
        }
      }
    }
    return { added, conflicts }
  })
}
