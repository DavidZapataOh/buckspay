import { describe, expect, it, vi } from 'vitest'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { accept, carried, forward, RelayRejected } from './inbox'
import { dumpBytes, indexOf, junk, sealedFixture } from './testing'

const store = async () => {
  const db = createNodeDb()
  await migrate(db)
  return db
}

describe('relayer inbox', () => {
  it('stores, forwards once, forgets the blob and answers repeats with the stored sealed response', async () => {
    const db = await store()
    const blob = sealedFixture().blob
    expect(await accept(db, blob, 1, 'peer-a')).toBe('stored')
    const response = new Uint8Array(304).fill(7)
    const post = vi.fn(async () => response)
    expect(await forward(db, post, 2)).toBe(1)
    expect(await accept(db, blob, 3, 'peer-a')).toEqual({ repeat: response })
    expect(await forward(db, post, 4)).toBe(0)
    expect(post).toHaveBeenCalledOnce()
    expect(await db.all('SELECT blob FROM relay_inbox')).toEqual([])
    expect(await carried(db)).toBe(1)
  })

  it('keeps the answer for a day and then posts a repeat again', async () => {
    const db = await store()
    const blob = sealedFixture().blob
    await accept(db, blob, 1, 'peer-a')
    await forward(db, async () => new Uint8Array(304), 2)
    await forward(db, async () => new Uint8Array(304), 2 + 86_400)
    expect(await accept(db, blob, 3 + 86_400, 'peer-a')).toBe('stored')
  })

  it('drops junk before storing and rate-limits a flooding peer', async () => {
    const db = await store()
    expect(await accept(db, junk({ length: 1000 }), 1, 'peer-a')).toBe('dropped')
    expect(await accept(db, junk({ keyId: 250 }), 1, 'peer-a')).toBe('dropped')
    for (let i = 0; i < 6; i++) expect(await accept(db, sealedFixture(i).blob, 1, 'peer-a')).toBe('stored')
    expect(await accept(db, sealedFixture(6).blob, 1, 'peer-a')).toBe('dropped')
    expect(await accept(db, sealedFixture(7).blob, 1, 'peer-b')).toBe('stored')
    expect(await accept(db, sealedFixture(8).blob, 62, 'peer-a')).toBe('stored')
  })

  it('limits all peers together to thirty a minute', async () => {
    const db = await store()
    for (let i = 0; i < 30; i++) expect(await accept(db, sealedFixture(i).blob, 5, `peer-${i}`)).toBe('stored')
    expect(await accept(db, sealedFixture(30).blob, 5, 'peer-new')).toBe('dropped')
  })

  it('refuses when sixty-four blobs wait', async () => {
    const db = await store()
    for (let i = 0; i < 64; i++) await accept(db, sealedFixture(i).blob, i * 60, `peer-${i}`)
    expect(await accept(db, sealedFixture(64).blob, 64 * 60, 'peer-64')).toBe('full')
  })

  it('backs a peer off, longer each time, after the gateway refused its blob', async () => {
    const db = await store()
    const refuse = async () => {
      throw new RelayRejected()
    }
    await accept(db, sealedFixture(0).blob, 100, 'peer-a')
    await forward(db, refuse, 100)
    expect(await accept(db, sealedFixture(1).blob, 109, 'peer-a')).toBe('dropped')
    expect(await accept(db, sealedFixture(1).blob, 110, 'peer-a')).toBe('stored')
    await forward(db, refuse, 110)
    expect(await accept(db, sealedFixture(2).blob, 129, 'peer-a')).toBe('dropped')
    expect(await accept(db, sealedFixture(2).blob, 130, 'peer-a')).toBe('stored')
  })

  it('keeps a blob it could not post for the next try', async () => {
    const db = await store()
    await accept(db, sealedFixture().blob, 1, 'peer-a')
    expect(
      await forward(
        db,
        async () => {
          throw new Error('offline')
        },
        2,
      ),
    ).toBe(0)
    expect(await db.all('SELECT id FROM relay_inbox')).toHaveLength(1)
  })

  it('stores nothing that names the payer or the amount', async () => {
    const db = await store()
    const { blob, payerKey, amountLe } = sealedFixture(0, { withSecrets: true })
    await accept(db, blob, 1, 'peer-a')
    await forward(db, async () => new Uint8Array(304), 2)
    const dump = await dumpBytes(db)
    expect(indexOf(dump, payerKey)).toBe(-1)
    expect(indexOf(dump, amountLe)).toBe(-1)
  })
})
