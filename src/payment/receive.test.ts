import { beforeEach, describe, expect, it } from 'vitest'
import { decodeCaveats, encodeOwner, GRACE, CHALLENGE, type Issue } from '../protocol'
import type { NoteDb } from '../features/notes/db'
import { migrate } from '../features/notes/schema'
import { createNodeDb } from '../features/notes/testing/node-db'
import { decodeBundle, encodeBundle, paymentId } from './messages'
import { Reason } from './reasons'
import { acceptPayment, type ReceiveContext } from './receive'
import { MINT, makeTicket, NOTE_DOMAIN, party, receiverFor, signIssue } from './testing/world'

const payer = party(1)
const shop = party(2)
const stranger = party(3)
const NOW = 1_800_000_000
const EXPIRY = NOW + 72 * 3600

function issue(over: Partial<Issue> = {}): Issue {
  return {
    issuer: payer.key,
    mint: MINT,
    lockSeq: 3,
    cumEnd: 7_000_000n,
    salt: new Uint8Array(16).fill(7),
    owner: { type: 'device', key: shop.key },
    amount: 5_000_000n,
    caveats: { expiry: EXPIRY, hopsLeft: 3, flags: 0, scopeKind: 0, scope: new Uint8Array(20) },
    ...over,
  }
}
const ticket = (over: Partial<Parameters<typeof makeTicket>[0]> = {}) =>
  makeTicket({
    device: payer.key,
    mint: MINT,
    lockSeq: 3,
    bond: 50_000_000n,
    backing: 100_000_000n,
    lockUntil: NOW + 30 * 86400,
    ...over,
  })
const payment = (i = issue(), t = ticket()) => encodeBundle({ issue: signIssue(payer, i), spends: [], tickets: [t] })

let db: NoteDb
const context = (over: Partial<ReceiveContext> = {}): ReceiveContext => ({
  receiver: receiverFor(shop, { now: NOW + 100 }),
  db,
  limits: { maxPayment: 100_000_000n },
  transport: 'qr',
  request: null,
  ...over,
})

beforeEach(async () => {
  db = createNodeDb()
  await migrate(db)
})
const rows = async (table: string) => (await db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0].n

describe('acceptPayment', () => {
  it('accepts a first payment, stores its bytes for settlement and names it by its id', async () => {
    const wire = payment()
    const outcome = await acceptPayment(wire, context({ request: { amount: 5_000_000n, memo: 'Coffee' } }))
    expect(outcome).toMatchObject({ accepted: true, duplicate: false })
    expect((await db.all<{ owner: Uint8Array }>('SELECT owner FROM received_note'))[0].owner).toEqual(
      encodeOwner({ type: 'device', key: shop.key }),
    )
    if (!outcome.accepted) return
    expect(outcome.messageId).toEqual(paymentId(NOTE_DOMAIN, decodeBundle(wire)))
    const [row] = await db.all<{
      amount: number
      state: string
      bundle: Uint8Array
      requested_amount: number
      memo: string
      caveats: Uint8Array
      hops_left: number
    }>('SELECT amount, state, bundle, requested_amount, memo, caveats, hops_left FROM received_note')
    expect(row).toMatchObject({
      amount: 5_000_000,
      state: 'held',
      requested_amount: 5_000_000,
      memo: 'Coffee',
      hops_left: 3,
    })
    expect(row.bundle).toEqual(wire)
    expect(decodeCaveats(row.caveats).expiry).toBe(EXPIRY)
    expect(await rows('note_liability')).toBe(1)
    expect(await rows('issue_claim')).toBe(1)
  })

  it('answers the same payment again as accepted, a duplicate, and stores nothing more', async () => {
    const wire = payment()
    await acceptPayment(wire, context())
    const again = await acceptPayment(wire, context())
    expect(again).toMatchObject({ accepted: true, duplicate: true })
    expect(await rows('received_note')).toBe(1)
  })

  it('accepts an amount other than the one asked for and records what was asked', async () => {
    const outcome = await acceptPayment(
      payment(issue({ amount: 3_000_000n, cumEnd: 5_000_000n })),
      context({ request: { amount: 5_000_000n, memo: '' } }),
    )
    expect(outcome.accepted).toBe(true)
    expect(
      (
        await db.all<{ amount: number; requested_amount: number }>('SELECT amount, requested_amount FROM received_note')
      )[0],
    ).toEqual({
      amount: 3_000_000,
      requested_amount: 5_000_000,
    })
  })

  describe('refuses, with the reason the receipt carries', () => {
    const refused = (reason: number) => ({ accepted: false, reason })

    it('a payment that is not ours: NotForYou', async () => {
      const wire = payment(issue({ owner: { type: 'device', key: stranger.key } }))
      expect(await acceptPayment(wire, context())).toMatchObject(refused(Reason.NotForYou))
    })

    it('a damaged signature: Signature', async () => {
      const wire = payment().slice()
      wire[3 + 163 + 10] ^= 1
      expect(await acceptPayment(wire, context())).toMatchObject(refused(Reason.Signature))
    })

    it('a damaged body: Signature', async () => {
      const wire = payment().slice()
      wire[3 + 2 + 33 + 32 + 4 + 3] ^= 1
      expect(await acceptPayment(wire, context())).toMatchObject(refused(Reason.Signature))
    })

    it('a ticket from an attester this phone does not know: Ticket', async () => {
      expect(await acceptPayment(payment(issue(), ticket({ attester: 99 })), context())).toMatchObject(
        refused(Reason.Ticket),
      )
    })

    it('a lock that ends before the note can be challenged: Ticket', async () => {
      const wire = payment(issue(), ticket({ lockUntil: EXPIRY + GRACE + CHALLENGE - 1 }))
      expect(await acceptPayment(wire, context())).toMatchObject(refused(Reason.Ticket))
    })

    it('a bond smaller than the payment: Ticket', async () => {
      expect(await acceptPayment(payment(issue(), ticket({ bond: 4_999_999n })), context())).toMatchObject(
        refused(Reason.Ticket),
      )
    })

    it('a note that expires before the minimum window: Window', async () => {
      const soon = issue({
        caveats: { expiry: NOW + 100 + 3599, hopsLeft: 3, flags: 0, scopeKind: 0, scope: new Uint8Array(20) },
      })
      expect(await acceptPayment(payment(soon), context())).toMatchObject(refused(Reason.Window))
    })

    it('a note with no hop left: Window', async () => {
      const spent = issue({
        caveats: { expiry: EXPIRY, hopsLeft: 0, flags: 0, scopeKind: 0, scope: new Uint8Array(20) },
      })
      expect(await acceptPayment(payment(spent), context())).toMatchObject(refused(Reason.Window))
    })

    it('bytes that are not a payment: Unreadable, with no payment id', async () => {
      expect(await acceptPayment(new Uint8Array(50), context())).toEqual({
        accepted: false,
        reason: Reason.Unreadable,
        messageId: null,
      })
      expect(await acceptPayment(Uint8Array.from([...payment(), 0]), context())).toMatchObject(
        refused(Reason.Unreadable),
      )
    })

    it("a payment above this phone's maximum: AboveMax", async () => {
      const big = issue({ amount: 60_000_000n, cumEnd: 62_000_000n })
      expect(
        await acceptPayment(
          payment(big, ticket({ bond: 240_000_000n })),
          context({ limits: { maxPayment: 50_000_000n } }),
        ),
      ).toMatchObject(refused(Reason.AboveMax))
    })

    it("a payer's lock that already backs all it can: OverLimit, and a lock that has room still pays", async () => {
      const bond = ticket({ bond: 100_000_000n })
      const pay = (amount: bigint, cumEnd: bigint, salt: number) =>
        acceptPayment(payment(issue({ amount, cumEnd, salt: new Uint8Array(16).fill(salt) }), bond), context())
      expect((await pay(25_000_000n, 25_000_000n, 7)).accepted).toBe(true)
      expect((await pay(20_000_000n, 45_000_000n, 8)).accepted).toBe(true)
      expect(await pay(10_000_000n, 55_000_000n, 9)).toMatchObject(refused(Reason.OverLimit))
      expect((await pay(5_000_000n, 50_000_000n, 10)).accepted).toBe(true)
    })

    it('an issue that overlaps one already accepted from the same lock: DoubleSpend, with both kept as evidence', async () => {
      await acceptPayment(payment(issue()), context())
      const clash = issue({ cumEnd: 9_000_000n, salt: new Uint8Array(16).fill(8) })
      expect(await acceptPayment(payment(clash), context())).toMatchObject(refused(Reason.DoubleSpend))
      expect(await rows('received_note')).toBe(1)
      expect(await rows('conflict_evidence')).toBe(1)
    })

    it('a payment it cannot store: NotSaved, and nothing half stored', async () => {
      db = createNodeDb((sql) => sql.includes('INTO note_liability'))
      await migrate(db)
      expect(await acceptPayment(payment(), context({ db }))).toMatchObject(refused(Reason.NotSaved))
      expect(await rows('received_note')).toBe(0)
    })
  })

  it('never throws for a hostile payload', async () => {
    const good = payment()
    for (let i = 0; i < good.length; i += 7) {
      const damaged = good.slice()
      damaged[i] ^= 0xff
      const outcome = await acceptPayment(damaged, context())
      expect(typeof outcome.accepted).toBe('boolean')
    }
  })
})
