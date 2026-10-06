import { describe, expect, it } from 'vitest'
import { createNodeDb } from '../notes/testing/node-db'
import { migrate } from '../notes/schema'
import { handOff } from './handoff'
import { dueRows, handOffRow } from './outbox'
import { fakeL2cap, indexOf, queueFixture, seen, sealedFixture } from './testing'

const store = async () => {
  const db = createNodeDb()
  await migrate(db)
  return db
}

describe('hand-off', () => {
  it('hands to at most three online beacons of this cluster seen in the last minute: two strongest, one random', async () => {
    const link = fakeL2cap({ storeReply: 0x01 })
    const beacons = [
      seen({ rssi: -50 }),
      seen({ rssi: -90 }),
      seen({ rssi: -60 }),
      seen({ rssi: -70 }),
      seen({ rssi: -40, online: false }),
      seen({ rssi: -30, clusterTag: Uint8Array.of(9, 9, 9, 9) }),
      seen({ rssi: -20, ageSeconds: 61 }),
    ]
    const r = await handOff(sealedFixture(), beacons, link, 3, () => 0.99)
    expect(r.stored).toBe(3)
    expect(link.connectedRssi()).toEqual([-50, -60, -90])
  })

  it('the bytes on the channel differ per hop for the same blob', async () => {
    const a = fakeL2cap({ storeReply: 0x01 })
    const b = fakeL2cap({ storeReply: 0x01 })
    const sealed = sealedFixture()
    await handOff(sealed, [seen({ rssi: -50 })], a, 1)
    await handOff(sealed, [seen({ rssi: -50 })], b, 1)
    expect(a.wireBytes()).not.toEqual(b.wireBytes())
    expect(indexOf(a.wireBytes(), sealed.blob.subarray(0, 64))).toBe(-1)
  })

  it('a retry answer keeps the outbox row and schedules a new hand-off', async () => {
    const db = await store()
    const link = fakeL2cap({ storeReply: 0x01, answer: { status: 'retry', retryAfter: 600 } })
    const row = await queueFixture(db)
    await handOffRow(db, row, [seen({ rssi: -50 })], link, 100)
    expect(await db.all('SELECT next_hand_at, answer, stored_by FROM relay_outbox WHERE id = ?', [row.id])).toEqual([
      { next_hand_at: 700, answer: 'retry', stored_by: 1 },
    ])
    expect(await dueRows(db, 699)).toEqual([])
    expect(await dueRows(db, 700)).toHaveLength(1)
  })

  it('an answer that ends the matter takes the row out of the hand-offs', async () => {
    const db = await store()
    const row = await queueFixture(db)
    await handOffRow(
      db,
      row,
      [seen({ rssi: -50 })],
      fakeL2cap({ storeReply: 0x01, answer: { status: 'submitted' } }),
      100,
    )
    expect(await dueRows(db, 1_000_000)).toEqual([])
  })

  it('counts only relayers that answered 0x01 and returns the first sealed answer that opens', async () => {
    const link = fakeL2cap({ storeReplies: [0x00, 0x01], answer: { status: 'submitted' } })
    const r = await handOff(sealedFixture(), [seen({ rssi: -50 }), seen({ rssi: -60 })], link, 3)
    expect(r).toEqual({ stored: 1, answer: { status: 'submitted' } })
  })

  it('ignores a forged answer that does not open', async () => {
    const link = fakeL2cap({ storeReply: 0x01, rawAnswer: new Uint8Array(64) })
    expect((await handOff(sealedFixture(), [seen({ rssi: -50 })], link, 3)).answer).toBeNull()
  })
})
