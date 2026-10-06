export type SqlValue = string | number | bigint | Uint8Array | null

export type Statements = {
  run(sql: string, params?: readonly SqlValue[]): Promise<void>
  all<T extends Record<string, unknown>>(sql: string, params?: readonly SqlValue[]): Promise<T[]>
}

/** The three calls the note store needs; expo-sqlite implements them in the app, `node:sqlite` in tests. */
export interface NoteDb extends Statements {
  exec(sql: string): Promise<void>
  /** One write transaction at a time: BEGIN IMMEDIATE, COMMIT, or ROLLBACK when `fn` throws. */
  transaction<T>(fn: (tx: Statements) => Promise<T>): Promise<T>
}
