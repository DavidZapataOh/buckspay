import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_NOTE_LIFE } from '../../protocol'
import { acceptPayment } from '../../payment/receive'
import { encodeBundle } from '../../payment/messages'
import {
  ATTESTER,
  makeTicket,
  MINT,
  NOTE_DOMAIN,
  NOW,
  party,
  PROGRAM,
  signIssue,
  TICKET_DOMAIN,
} from '../../payment/testing/world'
import type { NoteDb } from '../notes/db'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { MIN_WINDOW } from '../pay/limits'
import { receiverOf } from './receiver'

const payer = party(1)
const shop = party(2)
const domains = { noteDomain: NOTE_DOMAIN, ticketDomain: TICKET_DOMAIN, program: PROGRAM }

let db: NoteDb
beforeEach(async () => {
  db = createNodeDb()
  await migrate(db)
})

describe('the receiver of this wallet', () => {
  it('is built by the one acceptance policy, with the window and the note life of the limits', async () => {
    const receiver = await receiverOf(db, domains, shop.key, [ATTESTER], NOW)
    expect(receiver).toMatchObject({ minWindow: MIN_WINDOW, maxNoteLife: MAX_NOTE_LIFE, now: NOW, program: PROGRAM })
    expect(receiver.me).toEqual({ type: 'device', key: shop.key })
  })

  it('counts what unsettled notes rely on each attester, so the protocol check enforces its cap', async () => {
    const issue = signIssue(payer, {
      issuer: payer.key,
      mint: MINT,
      lockSeq: 3,
      cumEnd: 5_000_000n,
      salt: new Uint8Array(16),
      owner: { type: 'device', key: shop.key },
      amount: 5_000_000n,
      caveats: { expiry: NOW + 72 * 3600, hopsLeft: 3, flags: 0, scopeKind: 0, scope: new Uint8Array(20) },
    })
    const ticket = makeTicket({
      device: payer.key,
      mint: MINT,
      lockSeq: 3,
      bond: 200_000_000n,
      backing: 100_000_000n,
      lockUntil: NOW + 30 * 86_400,
    })
    const wire = encodeBundle({ issue, spends: [], tickets: [ticket] })
    const outcome = await acceptPayment(wire, {
      receiver: await receiverOf(db, domains, shop.key, [ATTESTER], NOW + 100),
      db,
      limits: { maxPayment: 100_000_000n },
      transport: 'qr',
      request: null,
    })
    expect(outcome.accepted).toBe(true)
    const after = await receiverOf(db, domains, shop.key, [ATTESTER], NOW + 200)
    expect(after.attesters[0].relied).toBe(5_000_000n)
  })
})
