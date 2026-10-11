import { beforeEach, describe, expect, it } from 'vitest'
import type { NoteDb } from './db'
import {
  commitReceived,
  PASS_ON_HOLD_SECONDS,
  type ReceivedNote,
  RELEASE_MARGIN_SECONDS,
  releaseHold,
  setNoteState,
  settleable,
} from './ledger'
import { migrate, PASS_ON_SCHEMA_VERSION } from './schema'
import { createNodeDb } from './testing/node-db'

const id = (n: number) => new Uint8Array(32).fill(n)
const ME = new Uint8Array(33).fill(2)
const GRACE = 600
const LIMITS = { maxPayment: 100_000_000n }

let seq = 0
const note = (overrides: Partial<ReceivedNote> = {}): ReceivedNote => {
  seq++
  return {
    outputId: id(10 + seq),
    messageId: id(60 + seq),
    owner: ME,
    mint: id(9),
    amount: 100_000n,
    expiry: 2_000_000_000,
    hopsLeft: 3,
    caveats: new Uint8Array(27),
    issuer: new Uint8Array(33).fill(3),
    lockSeq: 3,
    bundle: Uint8Array.of(seq),
    liable: [],
    claims: [],
    requestedAmount: null,
    memo: null,
    transport: 'nearby',
    receivedAt: 1_000,
    ...overrides,
  }
}

let db: NoteDb
beforeEach(async () => {
  db = createNodeDb()
  await migrate(db)
})

const store = async (overrides: Partial<ReceivedNote> = {}) => {
  const received = note(overrides)
  await commitReceived(db, received, LIMITS)
  return received.outputId
}
const listed = async (now: number) => (await settleable(db, now, GRACE)).map((row) => row.outputId)
const keepOf = async (outputId: Uint8Array) =>
  (await db.all<{ keep: number }>('SELECT keep FROM received_note WHERE output_id = ?', [outputId]))[0].keep

describe('the migration that lets a note wait for being passed on', () => {
  it('is the last version of the store and leaves a note kept for settling by default', async () => {
    const [row] = await db.all<{ user_version: number }>('PRAGMA user_version')
    expect(row.user_version).toBe(PASS_ON_SCHEMA_VERSION)
    expect(await keepOf(await store())).toBe(0)
  })

  it('records that a note was kept for passing on', async () => {
    expect(await keepOf(await store({ keep: true }))).toBe(1)
  })
})

describe('notes kept for passing on', () => {
  it('are not settled while they can be passed on, and the others are', async () => {
    const kept = await store({ keep: true })
    const other = await store()
    expect(await listed(1_000 + 3_600)).toEqual([other])
    expect(await listed(1_000 + PASS_ON_HOLD_SECONDS - 1)).toEqual([other])
    expect(await listed(1_000 + PASS_ON_HOLD_SECONDS)).toEqual(expect.arrayContaining([kept, other]))
  })

  it('are settled when little of their life is left, if that comes before the day is over', async () => {
    const expiry = 100_000
    const kept = await store({ keep: true, expiry })
    const releasedAt = expiry - RELEASE_MARGIN_SECONDS
    expect(await listed(releasedAt - 1)).toEqual([])
    expect(await listed(releasedAt)).toEqual([kept])
  })

  it('are settled at once when the person asks, and nothing else is', async () => {
    const kept = await store({ keep: true })
    const stays = await store({ keep: true })
    await releaseHold(db, kept)
    expect(await listed(1_000 + 60)).toEqual([kept])
    expect(await keepOf(stays)).toBe(1)
  })

  it('stay in the list once their settlement was prepared', async () => {
    const kept = await store({ keep: true })
    await setNoteState(db, kept, 'settling', 1_100)
    expect(await listed(1_000 + 60)).toEqual([kept])
  })
})
