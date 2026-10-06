import { describe, expect, it, vi } from 'vitest'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { enqueue, runUnlocked } from './locked-queue'

async function store() {
  const db = createNodeDb()
  await migrate(db)
  return db
}

describe('signature jobs', () => {
  it('runs queued jobs once, after unlock, and drops expired ones without running them', async () => {
    const db = await store()
    await enqueue(db, { id: 'a', kind: 'reclaim', payload: Uint8Array.of(1), notAfter: 2_000 })
    await enqueue(db, { id: 'b', kind: 'reclaim', payload: Uint8Array.of(2), notAfter: 500 })
    const run = vi.fn(async () => {})
    expect(await runUnlocked(db, run, 1_000)).toEqual({ ran: 1, expired: 1 })
    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith({ id: 'a', kind: 'reclaim', payload: Uint8Array.of(1), notAfter: 2_000 })
    expect(await runUnlocked(db, run, 1_001)).toEqual({ ran: 0, expired: 0 })
  })

  it('keeps a job whose run threw, for the next unlock', async () => {
    const db = await store()
    await enqueue(db, { id: 'a', kind: 'reclaim', payload: Uint8Array.of(1), notAfter: 2_000 })
    await runUnlocked(
      db,
      async () => {
        throw new Error('locked again')
      },
      1_000,
    )
    const run = vi.fn(async () => {})
    await runUnlocked(db, run, 1_100)
    expect(run).toHaveBeenCalledOnce()
  })

  it('enqueuing the same id twice keeps one job', async () => {
    const db = await store()
    for (let i = 0; i < 2; i++)
      await enqueue(db, { id: 'a', kind: 'reclaim', payload: Uint8Array.of(1), notAfter: 2_000 })
    const run = vi.fn(async () => {})
    await runUnlocked(db, run, 1_000)
    expect(run).toHaveBeenCalledOnce()
  })

  it('a job that expires exactly now is expired', async () => {
    const db = await store()
    await enqueue(db, { id: 'a', kind: 'reclaim', payload: Uint8Array.of(1), notAfter: 1_000 })
    expect(await runUnlocked(db, async () => {}, 1_000)).toEqual({ ran: 0, expired: 1 })
  })
})
