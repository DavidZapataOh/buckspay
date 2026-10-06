import { decodeBundle } from '../../payment/messages'
import type { WitnessRole, WitnessStore } from '../witness/port'
import type { PaymentFacts } from '../witness/session'
import type { NoteDb } from './db'

export const WITNESS_SCHEMA_VERSION = 2

const isDeviceKey = (key: Uint8Array) => key.length === 33 && (key[0] === 2 || key[0] === 3)

/** Adds the witness columns of the payer's rows and moves the version from 1 to 2; does nothing at 2 or above. */
export async function migrateWitness(db: NoteDb): Promise<void> {
  const [row] = await db.all<{ user_version: number }>('PRAGMA user_version')
  if (row.user_version >= WITNESS_SCHEMA_VERSION) return
  if (row.user_version !== 1) throw new Error('The note store must be at version 1 before the witness migration')
  await db.exec(`BEGIN;
ALTER TABLE outgoing_payment ADD COLUMN witness BLOB;
ALTER TABLE outgoing_payment ADD COLUMN witness_signed INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version = ${WITNESS_SCHEMA_VERSION};
COMMIT;`)
}

/** The issuer of a first payment; a chain has no signer to name until its last hop is exported. */
const firstPayer = (wire: Uint8Array): Uint8Array | null => {
  const { issue, spends } = decodeBundle(wire)
  return spends.length === 0 ? issue.message.issuer : null
}

export function createWitnessStore(
  db: NoteDb,
  payerOf: (bundle: Uint8Array) => Uint8Array | null = firstPayer,
): WitnessStore {
  const table = (role: WitnessRole) => (role === 'receiver' ? 'received_note' : 'outgoing_payment')

  async function facts(messageId: Uint8Array, role: WitnessRole): Promise<PaymentFacts | null> {
    if (role === 'receiver') {
      const [row] = await db.all<{ owner: Uint8Array; bundle: Uint8Array }>(
        'SELECT owner, bundle FROM received_note WHERE message_id = ?',
        [messageId],
      )
      const payerKey = row && payerOf(row.bundle)
      return payerKey && isDeviceKey(row.owner) && isDeviceKey(payerKey) ? { payerKey, receiverKey: row.owner } : null
    }
    const [row] = await db.all<{ device: Uint8Array; receiver: Uint8Array }>(
      "SELECT device, receiver FROM outgoing_payment WHERE message_id = ? AND state IN ('signed', 'confirmed')",
      [messageId],
    )
    return row && isDeviceKey(row.device) && isDeviceKey(row.receiver)
      ? { payerKey: row.device, receiverKey: row.receiver }
      : null
  }

  return {
    facts,
    async stored(messageId, role) {
      const [row] = await db.all<{ witness: Uint8Array | null }>(
        `SELECT witness FROM ${table(role)} WHERE message_id = ?`,
        [messageId],
      )
      return row?.witness ?? null
    },
    async record(messageId, role, evidence) {
      await db.run(`UPDATE ${table(role)} SET witness = ? WHERE message_id = ?`, [evidence, messageId])
    },
    countSignature: (messageId) =>
      db.transaction(async (tx) => {
        await tx.run('UPDATE outgoing_payment SET witness_signed = witness_signed + 1 WHERE message_id = ?', [
          messageId,
        ])
        const [row] = await tx.all<{ witness_signed: number }>(
          'SELECT witness_signed FROM outgoing_payment WHERE message_id = ?',
          [messageId],
        )
        return row ? row.witness_signed : Number.POSITIVE_INFINITY
      }),
  }
}
