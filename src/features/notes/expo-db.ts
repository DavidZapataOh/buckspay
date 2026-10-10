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

/** `expo-sqlite` on Android rejects every call with a native `NullPointerException` once its connection is gone. */
const isDeadConnection = (error: unknown) => String(error).includes('NullPointerException')

/**
 * The store over one open connection. `expo-sqlite`'s exclusive transactions open a second connection,
 * which does not have the SQLCipher key, so a transaction here runs on the one keyed connection and
 * everything else waits for it: statements are served in order, a transaction holds the queue from
 * `BEGIN IMMEDIATE` to its end, and the statements inside it skip the queue.
 *
 * When `reopen` is given, a statement (or a `BEGIN`) that fails because the connection is gone is retried once
 * on a new connection. A transaction that is already running is never moved: it fails and rolls back.
 */
export function createNoteDb(connection: SqliteConnection, reopen?: () => Promise<SqliteConnection>): NoteDb {
  let current = connection
  let queue: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work)
    queue = result.catch(() => undefined)
    return result
  }
  const outsideTransaction = async <T>(attempt: (open: SqliteConnection) => Promise<T>): Promise<T> => {
    try {
      return await attempt(current)
    } catch (error) {
      if (!reopen || !isDeadConnection(error)) throw error
      current = await reopen()
      return attempt(current)
    }
  }
  const run = (open: SqliteConnection, sql: string, params: readonly SqlValue[]) =>
    open.runAsync(sql, bind(params)).then(() => undefined)
  const all = <T extends Record<string, unknown>>(open: SqliteConnection, sql: string, params: readonly SqlValue[]) =>
    open.getAllAsync<T>(sql, bind(params))
  const statements: Statements = {
    run: (sql, params = []) => run(current, sql, params),
    all: (sql, params = []) => all(current, sql, params),
  }
  return {
    run: (sql, params = []) => enqueue(() => outsideTransaction((open) => run(open, sql, params))),
    all: (sql, params = []) => enqueue(() => outsideTransaction((open) => all(open, sql, params))),
    exec: (sql) => enqueue(() => outsideTransaction((open) => open.execAsync(sql))),
    transaction: (fn) =>
      enqueue(async () => {
        await outsideTransaction((open) => open.execAsync('BEGIN IMMEDIATE'))
        try {
          const result = await fn(statements)
          await current.execAsync('COMMIT')
          return result
        } catch (error) {
          await current.execAsync('ROLLBACK').catch(() => undefined)
          throw error
        }
      }),
  }
}
