import { afterEach, describe, expect, it } from 'vitest'
import { acceptPayment, type ReceiveContext } from '../../payment/receive'
import { Reason } from '../../payment/reasons'
import { ATTESTER, NOTE_DOMAIN, NOW, party, PROGRAM, TICKET_DOMAIN } from '../../payment/testing/world'
import { createLoopbackPair } from '../../transport/testing/loopback'
import type { SettlementGateway } from '../lock/gateway'
import type { NoteDb } from '../notes/db'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { settleHeld } from '../settlement/settle-held'
import { entriesSince } from './consumed'
import { pointGate, pointReceiverOf } from './point'
import { PointSync } from './point-sync'
import { eventWorld } from './testing'

const domains = { noteDomain: NOTE_DOMAIN, ticketDomain: TICKET_DOMAIN, program: PROGRAM }
const open: PointSync[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((sync) => sync.close()))
})

const until = async (done: () => Promise<boolean>) => {
  for (let i = 0; i < 200; i++) {
    if (await done()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out')
}

describe('the closed circuit of an event', () => {
  it('sells credit, refuses a second spend at the other point after one sync and settles what the points took', async () => {
    const w = eventWorld()
    const sent: { issue: string; spends: string[] }[] = []
    const gateway = {
      settle: async (request: { issue: string; spends: string[] }) => {
        sent.push(request)
        return { signature: '5sig' }
      },
    } as unknown as SettlementGateway
    const points = await Promise.all(
      [1, 2].map(async (id) => {
        const db: NoteDb = createNodeDb()
        await migrate(db)
        const sync = new PointSync({
          db,
          pairing: w.pairing,
          noteDomain: NOTE_DOMAIN,
          from: new Uint8Array(16).fill(id),
          now: () => NOW,
        })
        open.push(sync)
        const context = async (): Promise<ReceiveContext> => ({
          receiver: await pointReceiverOf(db, domains, w.pairing, [ATTESTER], NOW),
          db,
          limits: { maxPayment: 100_000_000n },
          transport: 'nearby',
          request: null,
          gate: pointGate(db, w.pairing, NOTE_DOMAIN, () => NOW),
        })
        return { db, sync, context }
      }),
    )
    const [one, two] = points
    const [a, b] = createLoopbackPair()
    one.sync.attach(a)
    two.sync.attach(b)

    const credit = w.issueCredit(10_000_000n)
    const first = w.payPoint(credit, 4_000_000n)
    expect(await acceptPayment(first.wire, await one.context())).toMatchObject({ accepted: true })
    await one.sync.push(await entriesSince(one.db, w.pairing.eventId, 0))
    await until(async () => (await entriesSince(two.db, w.pairing.eventId, 0)).length > 0)

    const again = w.payPoint(credit, 9_000_000n)
    expect(await acceptPayment(again.wire, await two.context())).toMatchObject({
      accepted: false,
      reason: Reason.DoubleSpend,
    })

    const change = w.payPoint(first.held!, 6_000_000n)
    expect(await acceptPayment(change.wire, await two.context())).toMatchObject({ accepted: true })

    for (const point of points) {
      const report = await settleHeld({
        db: point.db,
        wallet: w.pairing.authority,
        me: party(7).key,
        noteDomain: NOTE_DOMAIN,
        program: PROGRAM,
        signSpend: () => Promise.reject(new Error('a point signs nothing')),
        gateway,
        now: () => NOW + 1_000,
        salt: () => new Uint8Array(16),
        labelAcknowledged: async () => true,
        noticeShown: async () => true,
        random: () => 0.5,
        attempts: new Map(),
      })
      expect(report).toMatchObject({ settled: 1, failed: 0 })
    }
    expect(sent).toHaveLength(2)
  })
})
