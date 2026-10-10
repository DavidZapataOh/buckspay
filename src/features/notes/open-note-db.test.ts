import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Bound = string | number | Uint8Array | null

const opened: { options: unknown; database: ReturnType<typeof fake> }[] = []
let storedKey: string | null = null
let failures = 0

function fake() {
  const database = new DatabaseSync(':memory:')
  const state = { dead: false }
  const guard = () => {
    if (state.dead)
      throw new Error(
        "Call to function 'NativeDatabase.prepareAsync' has been rejected.\n→ Caused by: java.lang.NullPointerException",
      )
  }
  return {
    state,
    execAsync: async (sql: string) => {
      guard()
      database.exec(sql)
    },
    runAsync: async (sql: string, params: Bound[]) => {
      guard()
      database.prepare(sql).run(...params)
    },
    getAllAsync: async (sql: string, params: Bound[]) => {
      guard()
      return database.prepare(sql).all(...params)
    },
  }
}

vi.mock('expo-secure-store', () => ({
  getItemAsync: async () => storedKey,
  setItemAsync: async (_: string, value: string) => void (storedKey = value),
}))
vi.mock('expo-sqlite', () => ({
  deleteDatabaseAsync: async () => undefined,
  openDatabaseAsync: async (_: string, options?: unknown) => {
    if (failures-- > 0) throw new Error('disk')
    const database = fake()
    opened.push({ options, database })
    return database
  },
}))

beforeEach(() => {
  opened.length = 0
  failures = 0
  storedKey = 'ab'.repeat(32)
  vi.resetModules()
})

describe('opening the note store', () => {
  it('opens the database once per process however many callers ask', async () => {
    const { openNoteDb } = await import('./key')
    const [first, second] = await Promise.all([openNoteDb(), openNoteDb()])
    expect(first).toBe(second)
    expect(await openNoteDb()).toBe(first)
    expect(opened).toHaveLength(1)
  })

  it('opens it again when the first attempt failed', async () => {
    failures = 1
    const { openNoteDb } = await import('./key')
    await expect(openNoteDb()).rejects.toThrow('disk')
    await expect(openNoteDb()).resolves.toBeDefined()
  })

  it('replaces a dead connection with a new one and keeps working', async () => {
    const { openNoteDb } = await import('./key')
    const db = await openNoteDb()
    await db.run('CREATE TABLE IF NOT EXISTS probe (n INTEGER)')
    opened[0].database.state.dead = true
    await db.run('INSERT INTO probe (n) VALUES (1)').catch(() => undefined)
    expect(opened).toHaveLength(2)
    expect(opened[1].options).toEqual({ useNewConnection: true })
  })
})
