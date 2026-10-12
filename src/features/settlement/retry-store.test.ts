import { beforeEach, describe, expect, it } from 'vitest'
import type { NoteDb } from '../notes/db'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { clearRetry, loadRetries, saveRetry } from './retry-store'

const id = (n: number) => new Uint8Array(32).fill(n)
let db: NoteDb

beforeEach(async () => {
  db = createNodeDb()
  await migrate(db)
})

describe('when to ask the gateway again about a note', () => {
  it('keeps the attempts and the time of each note across runs', async () => {
    await saveRetry(db, id(1), { attempts: 2, nextAt: 1_000, kind: 'below_minimum', selfPay: false })
    await saveRetry(db, id(2), {
      attempts: 1,
      nextAt: 2_000,
      kind: 'limited',
      selfPay: true,
      reason: 'key_limit',
      retryAt: 2_000,
    })
    const loaded = await loadRetries(db)
    expect(loaded.get('01'.repeat(32))).toEqual({ attempts: 2, nextAt: 1_000, kind: 'below_minimum', selfPay: false })
    expect(loaded.get('02'.repeat(32))).toEqual({
      attempts: 1,
      nextAt: 2_000,
      kind: 'limited',
      selfPay: true,
      reason: 'key_limit',
      retryAt: 2_000,
    })
  })

  it('writes the same note again over its earlier answer', async () => {
    await saveRetry(db, id(1), { attempts: 1, nextAt: 1_000, kind: 'busy', selfPay: false })
    await saveRetry(db, id(1), { attempts: 2, nextAt: 5_000, kind: 'busy', selfPay: false })
    expect([...(await loadRetries(db)).values()]).toMatchObject([{ attempts: 2, nextAt: 5_000 }])
  })

  it('forgets a note once it is settled', async () => {
    await saveRetry(db, id(1), { attempts: 1, nextAt: 1_000, kind: 'busy', selfPay: false })
    await clearRetry(db, id(1))
    expect((await loadRetries(db)).size).toBe(0)
  })
})
