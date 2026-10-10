import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createNoteDb, type SqliteConnection } from './expo-db'

/** The calls of `expo-sqlite`'s database that the adapter uses, on Node's SQLite. */
function connection(): SqliteConnection {
  const database = new DatabaseSync(':memory:')
  database.exec('CREATE TABLE log (n INTEGER PRIMARY KEY AUTOINCREMENT, what TEXT NOT NULL)')
  return {
    execAsync: async (sql) => database.exec(sql),
    runAsync: async (sql, params) => void database.prepare(sql).run(...params),
    getAllAsync: async <T>(sql: string, params: (string | number | Uint8Array | null)[]) =>
      database.prepare(sql).all(...params) as T[],
  }
}

const logged = (db: ReturnType<typeof createNoteDb>) =>
  db.all<{ what: string }>('SELECT what FROM log ORDER BY n').then((rows) => rows.map((row) => row.what))
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('the note store over expo-sqlite', () => {
  it('commits what a transaction wrote and returns what it returns', async () => {
    const db = createNoteDb(connection())
    const result = await db.transaction(async (tx) => {
      await tx.run("INSERT INTO log (what) VALUES ('a')")
      return 7
    })
    expect(result).toBe(7)
    expect(await logged(db)).toEqual(['a'])
  })

  it('rolls everything back when the transaction throws, and keeps working', async () => {
    const db = createNoteDb(connection())
    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO log (what) VALUES ('lost')")
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await logged(db)).toEqual([])
    await db.run("INSERT INTO log (what) VALUES ('after')")
    expect(await logged(db)).toEqual(['after'])
  })

  it('lets one transaction at a time through, and holds every other statement until it ends', async () => {
    const db = createNoteDb(connection())
    const first = db.transaction(async (tx) => {
      await tx.run("INSERT INTO log (what) VALUES ('first-1')")
      await tick()
      await tx.run("INSERT INTO log (what) VALUES ('first-2')")
    })
    const outsider = db.run("INSERT INTO log (what) VALUES ('outsider')")
    const second = db.transaction(async (tx) => {
      await tx.run("INSERT INTO log (what) VALUES ('second')")
    })
    await Promise.all([first, outsider, second])
    expect(await logged(db)).toEqual(['first-1', 'first-2', 'outsider', 'second'])
  })

  it('does not stall after a failed statement', async () => {
    const db = createNoteDb(connection())
    await expect(db.run('INSERT INTO missing VALUES (1)')).rejects.toThrow()
    await db.run("INSERT INTO log (what) VALUES ('ok')")
    expect(await logged(db)).toEqual(['ok'])
  })

  it('opens the connection again and retries a statement when the connection died', async () => {
    const dead: SqliteConnection = {
      execAsync: async () => undefined,
      runAsync: async () => {
        throw new Error(
          "Call to function 'NativeDatabase.prepareAsync' has been rejected.\n→ Caused by: java.lang.NullPointerException",
        )
      },
      getAllAsync: async () => {
        throw new Error('java.lang.NullPointerException')
      },
    }
    let reopened = 0
    const db = createNoteDb(dead, async () => {
      reopened++
      return connection()
    })
    await db.run("INSERT INTO log (what) VALUES ('after')")
    expect(await logged(db)).toEqual(['after'])
    expect(reopened).toBe(1)
  })

  it('does not hide other errors behind a new connection', async () => {
    let reopened = 0
    const db = createNoteDb(connection(), async () => {
      reopened++
      return connection()
    })
    await expect(db.run('INSERT INTO missing VALUES (1)')).rejects.toThrow()
    expect(reopened).toBe(0)
  })

  it('never moves a running transaction to a new connection', async () => {
    const base = connection()
    let broken = false
    const flaky: SqliteConnection = {
      ...base,
      runAsync: async (sql, params) => {
        if (broken) throw new Error('java.lang.NullPointerException')
        return base.runAsync(sql, params)
      },
    }
    const replacement = connection()
    const db = createNoteDb(flaky, async () => replacement)
    await expect(
      db.transaction(async (tx) => {
        await tx.run("INSERT INTO log (what) VALUES ('before')")
        broken = true
        await tx.run("INSERT INTO log (what) VALUES ('lost')")
      }),
    ).rejects.toThrow('NullPointerException')
    broken = false
    const rows = await replacement.getAllAsync<{ what: string }>('SELECT what FROM log', [])
    expect(rows).toEqual([])
  })
})
