import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it, vi } from 'vitest'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { handOff, spray } from './handoff'
import { RelayRejected } from './inbox'
import { postRelay } from './relayer'
import { dumpBytes, indexOf, relayerLink, sealAnswer, sealedFixture, seen } from './testing'

const store = async () => {
  const db = createNodeDb()
  await migrate(db)
  return db
}

describe('a payment through a relayer', () => {
  it('goes to the gateway, comes back sealed, and the relayer keeps neither the payment nor the answer it can read', async () => {
    const db = await store()
    const sealed = sealedFixture(3)
    const post = vi.fn(async (blob: Uint8Array) =>
      sealAnswer(sealed.secret, blob.slice(1, 33), { status: 'submitted' }),
    )
    const link = relayerLink(db, post, () => 1_000)
    const result = await handOff(sealed, [seen({ rssi: -50 })], link, 3)
    expect(result).toEqual({ stored: 1, answer: { status: 'submitted' } })
    expect(post).toHaveBeenCalledOnce()
    expect(await db.all('SELECT blob FROM relay_inbox')).toEqual([])
    expect(indexOf(await dumpBytes(db), sealed.blob.subarray(0, 40))).toBe(-1)
  })

  it('answers a copy of a blob it already posted with the stored answer, without posting again', async () => {
    const db = await store()
    const sealed = sealedFixture(4)
    const post = vi.fn(async (blob: Uint8Array) =>
      sealAnswer(sealed.secret, blob.slice(1, 33), { status: 'duplicate' }),
    )
    const link = relayerLink(db, post, () => 1_000)
    await handOff(sealed, [seen({ rssi: -50 })], link, 1)
    expect(await handOff(sealed, [seen({ rssi: -50 })], link, 1)).toEqual({
      stored: 1,
      answer: { status: 'duplicate' },
    })
    expect(post).toHaveBeenCalledOnce()
  })

  it('says it did not keep a blob it cannot use, and keeps one it could not post for later', async () => {
    const db = await store()
    const offline = relayerLink(
      db,
      async () => {
        throw new Error('offline')
      },
      () => 1_000,
    )
    const sealed = sealedFixture(5)
    expect(await handOff(sealed, [seen({ rssi: -50 })], offline, 1)).toEqual({ stored: 1, answer: null })
    expect(await db.all('SELECT id FROM relay_inbox')).toEqual([{ id: sha256(sealed.blob) }])
    const rejecting = relayerLink(
      db,
      async () => {
        throw new RelayRejected()
      },
      () => 2_000,
    )
    expect((await handOff(sealedFixture(6), [seen({ rssi: -50 })], rejecting, 1)).stored).toBe(1)
    const tooSoon = await handOff(sealedFixture(7), [seen({ rssi: -50 })], rejecting, 1)
    expect(tooSoon).toEqual({ stored: 0, answer: null })
  })
})

describe('posting to the gateway', () => {
  const blob = new Uint8Array(1073).fill(1)
  const reply = (status: number, body = new Uint8Array(304)) => vi.fn(async () => new Response(body, { status }))

  it('sends the blob as octet-stream and returns the sealed answer', async () => {
    const request = reply(200, new Uint8Array(304).fill(9))
    expect(await postRelay('https://gw.example', request as never)(blob)).toEqual(new Uint8Array(304).fill(9))
    expect(request).toHaveBeenCalledWith('https://gw.example/v1/relay', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: blob,
    })
  })

  it('tells a blob the gateway refused from a gateway it could not reach', async () => {
    await expect(postRelay('https://gw.example', reply(400) as never)(blob)).rejects.toBeInstanceOf(RelayRejected)
    await expect(postRelay('https://gw.example', reply(502) as never)(blob)).rejects.not.toBeInstanceOf(RelayRejected)
  })
})

describe('a phone without internet', () => {
  it('takes nothing to post: a plain blob is refused and nothing is kept', async () => {
    const db = await store()
    const post = vi.fn(async () => new Uint8Array(0))
    const link = relayerLink(db, post, () => 1_000, false)
    expect(await handOff(sealedFixture(5), [seen({ rssi: -50 })], link, 1)).toEqual({ stored: 0, answer: null })
    expect(post).not.toHaveBeenCalled()
    expect(await db.all('SELECT id FROM carry')).toEqual([])
  })

  it('keeps a blob that comes with copies, and a phone with internet posts what a carrier sprays to it', async () => {
    const offline = await store()
    const sealed = sealedFixture(6)
    const carrier = seen({ rssi: -50, online: false })
    expect(
      await spray(
        sealed,
        8,
        [carrier],
        relayerLink(offline, vi.fn(), () => 1_000, false),
      ),
    ).toEqual({
      stored: 1,
      left: 4,
    })
    expect(await offline.all('SELECT copies FROM carry')).toEqual([{ copies: 4 }])
    const online = await store()
    const post = vi.fn(async () => new Uint8Array(0))
    expect(
      await spray(
        sealed,
        8,
        [carrier],
        relayerLink(online, post, () => 1_000, true),
      ),
    ).toMatchObject({ stored: 1 })
    expect(post).toHaveBeenCalledOnce()
  })
})
