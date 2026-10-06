import { beforeEach, describe, expect, it } from 'vitest'
import { encodeBundle } from '../../payment/messages'
import { acceptPayment, type ReceiveContext } from '../../payment/receive'
import { Reason } from '../../payment/reasons'
import { ATTESTER, NOTE_DOMAIN, NOW, PROGRAM, TICKET_DOMAIN } from '../../payment/testing/world'
import { receiverOf } from '../payment/receiver'
import type { NoteDb } from '../notes/db'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { pointGate, pointReceiverOf } from './point'
import { joinEvent } from './store'
import { eventWorld } from './testing'

const domains = { noteDomain: NOTE_DOMAIN, ticketDomain: TICKET_DOMAIN, program: PROGRAM }
const limits = { maxPayment: 100_000_000n }

let db: NoteDb
beforeEach(async () => {
  db = createNodeDb()
  await migrate(db)
})

describe('a point receiving payments', () => {
  const context = async (w: ReturnType<typeof eventWorld>): Promise<ReceiveContext> => ({
    receiver: await pointReceiverOf(db, domains, w.pairing, [ATTESTER], NOW),
    db,
    limits,
    transport: 'nearby',
    request: null,
    gate: pointGate(db, w.pairing, NOTE_DOMAIN, () => NOW),
  })

  it('accepts a payment of event credit as the organiser account', async () => {
    const w = eventWorld()
    const outcome = await acceptPayment(w.payPoint(w.issueCredit(10_000_000n), 4_000_000n).wire, await context(w))
    expect(outcome).toMatchObject({ accepted: true })
  })

  it('refuses a second spend of the same credit and still takes the first again', async () => {
    const w = eventWorld()
    const credit = w.issueCredit(10_000_000n)
    const [first, second] = [w.payPoint(credit, 4_000_000n), w.payPoint(credit, 5_000_000n)]
    const ctx = await context(w)
    expect(await acceptPayment(first.wire, ctx)).toMatchObject({ accepted: true })
    expect(await acceptPayment(second.wire, ctx)).toMatchObject({ accepted: false, reason: Reason.DoubleSpend })
    expect(await acceptPayment(first.wire, ctx)).toMatchObject({ accepted: true, duplicate: true })
  })

  it('refuses credit of an issuer the organiser did not list', async () => {
    const w = eventWorld({ issuerListed: false })
    const outcome = await acceptPayment(w.payPoint(w.issueCredit(1_000_000n), 1_000_000n).wire, await context(w))
    expect(outcome).toMatchObject({ accepted: false, reason: Reason.Scope })
  })
})

describe('an attendee receiving credit', () => {
  it('accepts it only after joining the event, and only until the event ends', async () => {
    const w = eventWorld()
    const wire = encodeBundle(w.issueCredit(2_000_000n).bundle)
    const receive = async (now: number) =>
      acceptPayment(wire, {
        receiver: await receiverOf(db, domains, w.attendee.key, [ATTESTER], now),
        db,
        limits,
        transport: 'qr',
        request: null,
      })
    expect(await receive(NOW)).toMatchObject({ accepted: false, reason: Reason.Scope })
    await joinEvent(db, w.pairing, NOW)
    expect(await receive(NOW)).toMatchObject({ accepted: true })
  })
})
