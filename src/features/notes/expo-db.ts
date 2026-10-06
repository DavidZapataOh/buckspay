import type { NoteDb, SqlValue, Statements } from './db'

type Bound = string | number | Uint8Array | null

/** The calls of an open `expo-sqlite` database that the store uses. */
export type SqliteConnection = {
  execAsync(source: string): Promise<void>
  runAsync(source: string, params: Bound[]): Promise<unknown>
  getAllAsync<T>(source: string, params: Bound[]): Promise<T[]>
}

function bind(params: readonly SqlValue[]): Bound[] {
  return params.map((value) => {
    if (typeof value !== 'bigint') return value
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))
      throw new RangeError('integer')
    return Number(value)
  })
}

/**
 * The store over one open connection. `expo-sqlite`'s exclusive transactions open a second connection,
 * which does not have the SQLCipher key, so a transaction here runs on the one keyed connection and
 * everything else waits for it: statements are served in order, a transaction holds the queue from
 * `BEGIN IMMEDIATE` to its end, and the statements inside it skip the queue.
 */
export function createNoteDb(connection: SqliteConnection): NoteDb {
  let queue: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work)
    queue = result.catch(() => undefined)
    return result
  }
  const statements: Statements = {
    run: (sql, params = []) => connection.runAsync(sql, bind(params)).then(() => undefined),
    all: (sql, params = []) => connection.getAllAsync(sql, bind(params)),
  }
  return {
    run: (sql, params) => enqueue(() => statements.run(sql, params)),
    all: (sql, params) => enqueue(() => statements.all(sql, params)),
    exec: (sql) => enqueue(() => connection.execAsync(sql)),
    transaction: (fn) =>
      enqueue(async () => {
        await connection.execAsync('BEGIN IMMEDIATE')
        try {
          const result = await fn(statements)
          await connection.execAsync('COMMIT')
          return result
        } catch (error) {
          await connection.execAsync('ROLLBACK')
          throw error
        }
      }),
  }
}
