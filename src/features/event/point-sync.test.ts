import { afterEach, describe, expect, it } from 'vitest'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { NOTE_DOMAIN } from '../../payment/testing/world'
import { createLoopbackPair } from '../../transport/testing/loopback'
import { MessageKind, type Message, type Transport } from '../../transport/types'
import { checkAtPoint, entriesSince } from './consumed'
import { pointGate } from './point'
import { MAX_SYNC_ENTRIES } from './sync'
import { PointSync } from './point-sync'
import { eventWorld } from './testing'

const NOW = 1_800_000_000
const open: PointSync[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((sync) => sync.close()))
})

async function point(pairing: ReturnType<typeof eventWorld>['pairing'], id: number) {
  const db = createNodeDb()
  await migrate(db)
  const sync = new PointSync({
    db,
    pairing,
    noteDomain: NOTE_DOMAIN,
    from: new Uint8Array(16).fill(id),
    now: () => NOW,
  })
  open.push(sync)
  return { db, sync }
}

const until = async (done: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await done()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out')
}

describe('two linked points', () => {
  it('refuse at the second what the first accepted, once its entry arrived', async () => {
    const w = eventWorld()
    const [one, two] = [await point(w.pairing, 1), await point(w.pairing, 2)]
    const [a, b] = createLoopbackPair()
    one.sync.attach(a)
    two.sync.attach(b)
    const credit = w.issueCredit(10_000_000n)
    const first = w.payPoint(credit, 4_000_000n)
    const gate = pointGate(one.db, w.pairing, NOTE_DOMAIN, () => NOW)
    expect(await gate.admit(first.received, first.bundle)).toBeNull()
    await one.sync.push(await entriesSince(one.db, w.pairing.eventId, 0))
    await until(async () => (await entriesSince(two.db, w.pairing.eventId, 0)).length > 0)
    const second = w.payPoint(credit, 9_000_000n)
    expect(await checkAtPoint(two.db, w.pairing, NOTE_DOMAIN, second.received, second.bundle)).toMatchObject({
      ok: false,
      reason: 'DoubleSpent',
    })
    expect(two.sync.status()).toEqual({ peers: 1, syncedAt: NOW })
  })

  it('report a double spend that two points accepted before they met, once', async () => {
    const w = eventWorld()
    const [one, two] = [await point(w.pairing, 1), await point(w.pairing, 2)]
    const credit = w.issueCredit(10_000_000n)
    for (const [target, amount] of [
      [one, 4_000_000n],
      [two, 5_000_000n],
    ] as const) {
      const p = w.payPoint(credit, amount)
      await pointGate(target.db, w.pairing, NOTE_DOMAIN, () => NOW).admit(p.received, p.bundle)
    }
    const conflicts: unknown[] = []
    const [a, b] = createLoopbackPair()
    const meeting = new PointSync({
      db: two.db,
      pairing: w.pairing,
      noteDomain: NOTE_DOMAIN,
      from: new Uint8Array(16).fill(3),
      now: () => NOW,
      onConflict: (conflict) => conflicts.push(conflict),
    })
    open.push(meeting)
    meeting.attach(b)
    one.sync.attach(a)
    await one.sync.exchange()
    await until(async () => conflicts.length > 0)
    await one.sync.exchange()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(conflicts).toHaveLength(1)
  })

  it('drop a message under another secret and keep listening', async () => {
    const w = eventWorld()
    const other = { ...w.pairing, eventSecret: new Uint8Array(32).fill(8) }
    const [one, two] = [await point(other, 1), await point(w.pairing, 2)]
    const [a, b] = createLoopbackPair()
    one.sync.attach(a)
    two.sync.attach(b)
    const p = w.payPoint(w.issueCredit(10_000_000n), 4_000_000n)
    await pointGate(one.db, other, NOTE_DOMAIN, () => NOW).admit(p.received, p.bundle)
    await one.sync.exchange()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await entriesSince(two.db, w.pairing.eventId, 0)).toHaveLength(0)
    expect(two.sync.status().syncedAt).toBeNull()
  })

  it('send what it knows in messages of at most sixty entries', async () => {
    const w = eventWorld()
    const sent: Message[] = []
    const recorder = {
      send: async (message: Message) => void sent.push(message),
      receive: () => new Promise<Message>(() => undefined),
      close: async () => undefined,
    } as unknown as Transport
    const { sync } = await point(w.pairing, 1)
    sync.attach(recorder)
    const entries = Array.from({ length: 2 * MAX_SYNC_ENTRIES + 10 }, (_, i) => ({
      output: new Uint8Array(32).fill(i + 1),
      content: new Uint8Array(32),
      signature: new Uint8Array(64),
      seenAt: NOW,
    }))
    await sync.push(entries)
    expect(sent.map((m) => m.kind)).toEqual([MessageKind.EventSync, MessageKind.EventSync, MessageKind.EventSync])
    expect(sent.map((m) => m.payload.length)).toEqual([7_987, 7_987, 67 + 10 * 132])
  })
})
