import { DatabaseSync } from 'node:sqlite'
import type { NoteDb, SqlValue, Statements } from '../db'

/** Test driver: the same SQL on Node's built-in SQLite, so the store's logic runs in Vitest. SQLCipher is checked on a device. */
export function createNodeDb(failOnStatement?: (sql: string, count: number) => boolean): NoteDb {
  const database = new DatabaseSync(':memory:')
  let count = 0
  const statements: Statements = {
    async run(sql, params = []) {
      if (failOnStatement?.(sql, ++count)) throw new Error('injected failure')
      database.prepare(sql).run(...(params as SqlValue[]))
    },
    async all(sql, params = []) {
      return database.prepare(sql).all(...(params as SqlValue[])) as never
    },
  }
  let queue: Promise<unknown> = Promise.resolve()
  return {
    ...statements,
    async exec(sql) {
      database.exec(sql)
    },
    transaction(fn) {
      const run = async () => {
        database.exec('BEGIN IMMEDIATE')
        try {
          const result = await fn(statements)
          database.exec('COMMIT')
          return result
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
      }
      const result = queue.then(run, run)
      queue = result.catch(() => undefined)
      return result
    },
  }
}
