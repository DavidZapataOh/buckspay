import { describe, expect, it } from 'vitest'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { acceptCarry, answeredByRelayer, postCarried, SPRAY_COPIES, split, toHand } from './carry'
import { RelayRejected } from './inbox'
import { junk, sealedFixture } from './testing'

const fresh = async () => {
  const db = createNodeDb()
  await migrate(db)
  return db
}

describe('spray and wait', () => {
  it('splits binary and keeps at least one', () => {
    expect(split(SPRAY_COPIES)).toEqual({ give: 4, keep: 4 })
    expect(split(3)).toEqual({ give: 1, keep: 2 })
    expect(split(1)).toEqual({ give: 0, keep: 1 })
  })
  it('with one copy, hands only to online phones (wait phase)', async () => {
    const db = await fresh()
    await acceptCarry(db, sealedFixture(1).blob, 1, 0)
    expect(await toHand(db, { online: false }, 1)).toEqual([])
    expect(await toHand(db, { online: true }, 1)).toHaveLength(1)
  })
  it('a carrier with copies hands half to another carrier and keeps the rest', async () => {
    const db = await fresh()
    await acceptCarry(db, sealedFixture(1).blob, 4, 0)
    expect((await toHand(db, { online: false }, 1))[0].copies).toBe(2)
    expect((await toHand(db, { online: false }, 2))[0].copies).toBe(1)
    expect(await toHand(db, { online: false }, 3)).toEqual([])
    expect(await toHand(db, { online: true }, 3)).toHaveLength(1)
  })
  it('drops a carried blob once an online relayer answered for it', async () => {
    const db = await fresh()
    await acceptCarry(db, sealedFixture(1).blob, 1, 0)
    const [b] = await toHand(db, { online: true }, 1)
    await answeredByRelayer(db, b.id, 2)
    expect(await toHand(db, { online: true }, 3)).toEqual([])
  })
  it('caps copies a peer claims, drops after 72 hours, refuses at 64 blobs', async () => {
    const db = await fresh()
    await acceptCarry(db, sealedFixture(1).blob, 200, 0)
    expect((await toHand(db, { online: false }, 1))[0].copies).toBeLessThanOrEqual(SPRAY_COPIES / 2)
    expect(await toHand(db, { online: true }, 72 * 3600 + 1)).toEqual([])
    for (let i = 2; i < 66; i++) await acceptCarry(db, sealedFixture(i).blob, 1, 0)
    expect(await acceptCarry(db, sealedFixture(99).blob, 1, 0)).toBe('full')
  })
  it('posts what it carries when it comes online, and forgets what the gateway took or refused', async () => {
    const db = await fresh()
    for (const i of [1, 2, 3]) await acceptCarry(db, sealedFixture(i).blob, 2, 0)
    let calls = 0
    const post = async () => {
      if (++calls === 2) throw new RelayRejected()
      if (calls === 3) throw new Error('offline')
      return new Uint8Array(0)
    }
    expect(await postCarried(db, post, 1)).toBe(1)
    expect(await toHand(db, { online: true }, 2)).toHaveLength(1)
  })
  it('takes a blob once, and refuses what is not a sealed settlement', async () => {
    const db = await fresh()
    expect(await acceptCarry(db, sealedFixture(1).blob, 2, 0)).toBe('stored')
    expect(await acceptCarry(db, sealedFixture(1).blob, 2, 1)).toBe('repeat')
    expect(await acceptCarry(db, junk({ length: 100 }), 2, 0)).toBe('dropped')
    expect(await acceptCarry(db, junk({ keyId: 250 }), 2, 0)).toBe('dropped')
  })
})
