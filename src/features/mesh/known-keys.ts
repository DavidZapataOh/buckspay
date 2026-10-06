import { type Owner, type Spend } from '../../protocol'
import { type Bundle, decodeBundle } from '../../payment/messages'
import type { NoteDb } from '../notes/db'

const deviceKeys = (...owners: Owner[]) => owners.flatMap((owner) => (owner.type === 'device' ? [owner.key] : []))

const spendOwners = ({ outputs }: Spend) =>
  outputs.type === 'one' ? deviceKeys(outputs.owner) : deviceKeys(outputs.owner0, outputs.owner1)

/** The device keys named in a chain: its issuer and every holder it passed through. */
export const chainKeys = ({ issue, spends }: Bundle): Uint8Array[] => [
  issue.message.issuer,
  ...deviceKeys(issue.message.owner),
  ...spends.flatMap((spend) => spendOwners(spend.message)),
]

const SINGLE_KEY_QUERIES = [
  'SELECT 1 AS found FROM received_note WHERE issuer = ? LIMIT 1',
  'SELECT 1 AS found FROM note_liability WHERE device = ? LIMIT 1',
  'SELECT 1 AS found FROM outgoing_payment WHERE device = ? LIMIT 1',
  'SELECT 1 AS found FROM lock_cursor WHERE device = ? LIMIT 1',
]

/** Whether `key` appears in a chain this phone stored, in one of its tickets, or owns a lock it knows. */
export async function isKnownKey(db: NoteDb, key: Uint8Array): Promise<boolean> {
  for (const sql of SINGLE_KEY_QUERIES) {
    const [row] = await db.all(sql, [key])
    if (row) return true
  }
  const rows = await db.all<{ bundle: Uint8Array }>('SELECT bundle FROM received_note')
  return rows.some((row) =>
    chainKeys(decodeBundle(row.bundle)).some(
      (known) => known.length === key.length && known.every((b, i) => b === key[i]),
    ),
  )
}
