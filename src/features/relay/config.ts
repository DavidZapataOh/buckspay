import type { GatewayConfig } from '../../protocol/hpke'
import type { NoteDb } from '../notes/db'

type Listed = { keyId: number; publicKey: string }

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))

/** The configuration last fetched from the gateway, or `null` when none was. */
export async function loadConfig(db: NoteDb): Promise<GatewayConfig | null> {
  const [row] = await db.all<{ fetched_at: number; keys: string }>('SELECT fetched_at, keys FROM relay_config')
  if (!row) return null
  const keys = (JSON.parse(row.keys) as Listed[]).map((key) => ({
    keyId: key.keyId,
    publicKey: fromBase64(key.publicKey),
  }))
  return { keys, fetchedAt: row.fetched_at }
}

/** Fetches `/v1/hpke-config` and keeps the keys it lists: the app only revokes pinned keys with it, it never trusts a new one. */
export async function refreshConfig(
  db: NoteDb,
  get: () => Promise<{ keys: Listed[] }>,
  now: number,
): Promise<GatewayConfig> {
  const { keys } = await get()
  const listed = keys.map(({ keyId, publicKey }) => ({ keyId, publicKey }))
  await db.run('INSERT OR REPLACE INTO relay_config (id, fetched_at, keys) VALUES (1, ?, ?)', [
    now,
    JSON.stringify(listed),
  ])
  return { keys: listed.map((key) => ({ keyId: key.keyId, publicKey: fromBase64(key.publicKey) })), fetchedAt: now }
}
