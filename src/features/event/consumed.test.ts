import { beforeEach, describe, expect, it } from 'vitest'
import type { NoteDb } from '../notes/db'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { checkAtPoint, entriesSince, recordAtPoint } from './consumed'
import { applySync } from './sync'
import { NOTE_DOMAIN } from '../../payment/testing/world'
import { eventWorld } from './testing'

const freshDb = async () => {
  const db = createNodeDb()
  await migrate(db)
  return db
}

let db: NoteDb
beforeEach(async () => {
  db = await freshDb()
})

describe('a point', () => {
  it('accepts a first payment and records what it consumed', async () => {
    const w = eventWorld()
    const p = w.payPoint(w.issueCredit(10_000_000n), 4_000_000n)
    const check = await checkAtPoint(db, w.pairing, NOTE_DOMAIN, p.received, p.bundle)
    expect(check.ok).toBe(true)
    if (!check.ok) return
    await recordAtPoint(db, w.pairing.eventId, check.entries)
    expect(await entriesSince(db, w.pairing.eventId, 0)).toHaveLength(check.entries.length)
  })

  it('accepts the same payment again: a replay is not a double spend', async () => {
    const w = eventWorld()
    const p = w.payPoint(w.issueCredit(10_000_000n), 4_000_000n)
    const a = await checkAtPoint(db, w.pairing, NOTE_DOMAIN, p.received, p.bundle)
    if (a.ok) await recordAtPoint(db, w.pairing.eventId, a.entries)
    expect((await checkAtPoint(db, w.pairing, NOTE_DOMAIN, p.received, p.bundle)).ok).toBe(true)
  })

  it('refuses the same note spent again with another body, and keeps the conflict', async () => {
    const w = eventWorld()
    const credit = w.issueCredit(10_000_000n)
    const first = w.payPoint(credit, 4_000_000n)
    const second = w.payPoint(credit, 5_000_000n)
    const a = await checkAtPoint(db, w.pairing, NOTE_DOMAIN, first.received, first.bundle)
    if (a.ok) await recordAtPoint(db, w.pairing.eventId, a.entries)
    const b = await checkAtPoint(db, w.pairing, NOTE_DOMAIN, second.received, second.bundle)
    expect(b).toMatchObject({ ok: false, reason: 'DoubleSpent' })
    expect(b.ok === false && b.conflict).toBeTruthy()
  })

  it('accepts a later payment from the change of an earlier one', async () => {
    const w = eventWorld()
    const first = w.payPoint(w.issueCredit(10_000_000n), 4_000_000n)
    const a = await checkAtPoint(db, w.pairing, NOTE_DOMAIN, first.received, first.bundle)
    if (a.ok) await recordAtPoint(db, w.pairing.eventId, a.entries)
    const second = w.payPoint(first.held!, 6_000_000n)
    expect((await checkAtPoint(db, w.pairing, NOTE_DOMAIN, second.received, second.bundle)).ok).toBe(true)
  })

  it('refuses at the other point once the two have synced', async () => {
    const w = eventWorld()
    const two = await freshDb()
    const credit = w.issueCredit(10_000_000n)
    const a = w.payPoint(credit, 4_000_000n)
    const checked = await checkAtPoint(db, w.pairing, NOTE_DOMAIN, a.received, a.bundle)
    if (!checked.ok) throw new Error('first payment refused')
    await recordAtPoint(db, w.pairing.eventId, checked.entries)
    await applySync(two, w.pairing, NOTE_DOMAIN, checked.entries)
    const b = w.payPoint(credit, 9_000_000n)
    expect(await checkAtPoint(two, w.pairing, NOTE_DOMAIN, b.received, b.bundle)).toMatchObject({
      ok: false,
      reason: 'DoubleSpent',
    })
  })

  it('reports a conflict that arrives by sync and blocks the key', async () => {
    const w = eventWorld()
    const two = await freshDb()
    const credit = w.issueCredit(10_000_000n)
    for (const [target, amount] of [
      [db, 4_000_000n],
      [two, 5_000_000n],
    ] as const) {
      const p = w.payPoint(credit, amount)
      const c = await checkAtPoint(target, w.pairing, NOTE_DOMAIN, p.received, p.bundle)
      if (c.ok) await recordAtPoint(target, w.pairing.eventId, c.entries)
    }
    const result = await applySync(two, w.pairing, NOTE_DOMAIN, await entriesSince(db, w.pairing.eventId, 0))
    expect(result.conflicts).toHaveLength(1)
    const again = w.payPoint(w.issueCredit(1_000_000n), 1_000_000n)
    expect(await checkAtPoint(two, w.pairing, NOTE_DOMAIN, again.received, again.bundle)).toMatchObject({
      ok: false,
      reason: 'KeyBlocked',
    })
  })

  it('does not let an entry nobody signed refuse a valid payment', async () => {
    const w = eventWorld()
    const credit = w.issueCredit(10_000_000n)
    const p = w.payPoint(credit, 4_000_000n)
    const real = await checkAtPoint(await freshDb(), w.pairing, NOTE_DOMAIN, p.received, p.bundle)
    if (!real.ok) throw new Error('refused')
    const forged = real.entries.map((e) => ({
      ...e,
      content: new Uint8Array(32).fill(0xee),
      signature: new Uint8Array(64).fill(1),
    }))
    await applySync(db, w.pairing, NOTE_DOMAIN, forged)
    expect((await checkAtPoint(db, w.pairing, NOTE_DOMAIN, p.received, p.bundle)).ok).toBe(true)
  })

  it('refuses a note from an issuer the pairing does not list', async () => {
    const w = eventWorld({ issuerListed: false })
    const p = w.payPoint(w.issueCredit(1_000_000n), 1_000_000n)
    expect(await checkAtPoint(db, w.pairing, NOTE_DOMAIN, p.received, p.bundle)).toMatchObject({
      ok: false,
      reason: 'IssuerNotListed',
    })
  })

  it('refuses a payment to another authority', async () => {
    const w = eventWorld()
    const p = w.payPoint(w.issueCredit(1_000_000n), 1_000_000n)
    const other = { ...w.pairing, authority: new Uint8Array(32).fill(0x42) }
    expect(await checkAtPoint(db, other, NOTE_DOMAIN, p.received, p.bundle)).toMatchObject({
      ok: false,
      reason: 'NotThisEvent',
    })
  })
})

describe('applySync', () => {
  it('adds what it did not know once and ignores what it did', async () => {
    const w = eventWorld()
    const p = w.payPoint(w.issueCredit(10_000_000n), 4_000_000n)
    const c = await checkAtPoint(await freshDb(), w.pairing, NOTE_DOMAIN, p.received, p.bundle)
    if (!c.ok) throw new Error('refused')
    expect(await applySync(db, w.pairing, NOTE_DOMAIN, c.entries)).toEqual({ added: c.entries.length, conflicts: [] })
    expect(await applySync(db, w.pairing, NOTE_DOMAIN, c.entries)).toEqual({ added: 0, conflicts: [] })
  })

  it('sends only what is newer than the cursor', async () => {
    const w = eventWorld()
    const p = w.payPoint(w.issueCredit(10_000_000n), 4_000_000n)
    const c = await checkAtPoint(db, w.pairing, NOTE_DOMAIN, p.received, p.bundle, 1_800_000_100)
    if (c.ok) await recordAtPoint(db, w.pairing.eventId, c.entries)
    expect(await entriesSince(db, w.pairing.eventId, 1_800_000_100)).toHaveLength(0)
    expect((await entriesSince(db, w.pairing.eventId, 1_800_000_099)).length).toBeGreaterThan(0)
  })
})
