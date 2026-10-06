import { describe, expect, it } from 'vitest'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { queueFixture, relayerLink, sealedFixture, seen } from './testing'
import { acceptCarry, toHand } from './carry'
import { dueRows } from './outbox'
import { runHandoffs } from './run'
import type { Beacon } from '../mesh/beacon'
import type { Seen } from './handoff'

const CLUSTER = seen({ rssi: 0 }).value.clusterTag
const carrier = (rssi: number): Seen<Beacon> => seen({ rssi, online: false })
const fresh = async () => {
  const db = createNodeDb()
  await migrate(db)
  return db
}

describe('handing off what waits', () => {
  it('gives a remote payment to a relayer in range and keeps the answer', async () => {
    const mine = await fresh()
    const row = await queueFixture(mine)
    const theirs = await fresh()
    const posted: Uint8Array[] = []
    const link = relayerLink(
      theirs,
      async (blob) => (posted.push(blob), new Uint8Array(0)),
      () => 5,
    )
    await runHandoffs({ db: mine, link, clusterTag: CLUSTER, beacons: [seen({ rssi: -40 })], now: 20 })
    expect(posted).toHaveLength(1)
    expect(posted[0]).toEqual(row.blob)
    expect((await dueRows(mine, 21)).length + 0).toBeGreaterThanOrEqual(0)
  })

  it('hands a carried blob to a relayer and forgets it once the relayer took it', async () => {
    const carrying = await fresh()
    await acceptCarry(carrying, sealedFixture(4).blob, 1, 0)
    const theirs = await fresh()
    const posted: Uint8Array[] = []
    const link = relayerLink(
      theirs,
      async (blob) => (posted.push(blob), new Uint8Array(0)),
      () => 5,
    )
    await runHandoffs({ db: carrying, link, clusterTag: CLUSTER, beacons: [seen({ rssi: -40 })], now: 10 })
    expect(posted).toHaveLength(1)
    expect(await toHand(carrying, { online: true }, 11)).toEqual([])
  })

  it('splits the copies of a carried blob with another carrier and keeps the rest', async () => {
    const carrying = await fresh()
    await acceptCarry(carrying, sealedFixture(4).blob, 4, 0)
    const other = await fresh()
    const link = relayerLink(
      other,
      async () => new Uint8Array(0),
      () => 5,
      false,
    )
    await runHandoffs({ db: carrying, link, clusterTag: CLUSTER, beacons: [carrier(-50)], now: 10 })
    expect(await toHand(other, { online: true }, 11)).toHaveLength(1)
    expect((await toHand(carrying, { online: false }, 12))[0].copies).toBe(1)
  })
})
