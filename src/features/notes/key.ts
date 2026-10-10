import { bytesToHex } from '@noble/hashes/utils.js'
import * as SecureStore from 'expo-secure-store'
import * as SQLite from 'expo-sqlite'
import type { NoteDb } from './db'
import { createNoteDb } from './expo-db'
import { migrate } from './schema'

const KEY_ITEM = 'buckspay.notes.key'
const DATABASE = 'notes.db'

export type KeyStorage = {
  get(): Promise<string | null>
  set(key: string): Promise<void>
}

/**
 * The 32-byte key that opens the note store, made on first use and kept in Keystore-wrapped storage
 * that is never backed up. `created` says there was none: a store left from before is then unreadable.
 */
export async function noteKey(
  storage: KeyStorage,
  random: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(32)),
): Promise<{ key: string; created: boolean }> {
  const stored = await storage.get()
  if (stored && /^[0-9a-f]{64}$/.test(stored)) return { key: stored, created: false }
  const key = bytesToHex(random())
  await storage.set(key)
  return { key, created: true }
}

const secureStorage: KeyStorage = {
  get: () => SecureStore.getItemAsync(KEY_ITEM),
  set: (key) => SecureStore.setItemAsync(KEY_ITEM, key),
}

let store: Promise<NoteDb> | undefined

/**
 * The encrypted note store, opened once per process and shared by every caller. `expo-sqlite` on Android answers a
 * second open of the same database with the same native object under a new JavaScript wrapper, and collecting any
 * stale wrapper then destroys the connection that is still in use (expo/expo#48999).
 */
export function openNoteDb(): Promise<NoteDb> {
  store ??= createStore().catch((failure: unknown) => {
    store = undefined
    throw failure
  })
  return store
}

async function createStore(): Promise<NoteDb> {
  const { key, created } = await noteKey(secureStorage)
  if (created) await SQLite.deleteDatabaseAsync(DATABASE).catch(() => undefined)
  const open = async (options?: SQLite.SQLiteOpenOptions) => {
    const database = await SQLite.openDatabaseAsync(DATABASE, options)
    await database.execAsync(`PRAGMA key = "x'${key}'"`)
    await database.execAsync('PRAGMA journal_mode = WAL')
    await database.execAsync('PRAGMA synchronous = FULL')
    await database.execAsync('PRAGMA foreign_keys = ON')
    return database
  }
  // A plain reopen would be served the dead native object again; only a new connection replaces it.
  const db = createNoteDb(await open(), () => open({ useNewConnection: true }))
  await migrate(db)
  return db
}
