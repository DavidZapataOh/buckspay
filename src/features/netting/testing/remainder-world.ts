import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { decodeIou, iouEnvelope } from '../../../protocol'
import { buildRequest } from '../../../payment/request'
import { createSoftSigner } from '../../../payment/testing/soft-guard'
import {
  ATTESTER,
  MINT,
  NOW,
  NOTE_DOMAIN,
  party as payParty,
  payCtx,
  receiverFor,
} from '../../../payment/testing/world'
import { appliedNettings, coSignedStates, openTab, repayStatuses, saveCoSigned } from '../../debts/store'
import { balance, expectedBalance } from '../../debts/tab'
import { coSigned, IOU_DOMAIN, iouOf, party as debtParty } from '../../debts/testing'
import { migrate } from '../../notes/schema'
import { createNodeDb } from '../../notes/testing/node-db'
import { type RemainderDeps, type RemainderTab, collectRemainder } from '../remainder'
import { receivedPaymentIn, PAYMENT_WINDOW_SECS } from '../sweep'
import { createSession } from '../session-store'
import { relayNetwork } from './relay'
import { tabSecretOf } from './people'

const U = 1_000_000n
const LIMITS = {
  noteLifetime: 72 * 3600,
  noteHops: 3,
  requestTtl: 600,
  skewTolerance: 120,
  transferMargin: 120,
  maxPayment: 100_000_000n,
  biometricFrom: 20_000_000n,
  biometricDaily: 50_000_000n,
}

export type WorldOptions = { remaining?: bigint[]; debtorBacking?: bigint; authenticate?: () => Promise<boolean> }

/** A host (0), a debtor (1) and a creditor (2) with real stores, keys and payment flows over an in-memory relay. */
export async function remainderWorld(o: WorldOptions = {}) {
  const remaining = o.remaining ?? [5n * U]
  const net = relayNetwork(3)
  const host = payParty(1)
  const keys = { d: payParty(2), c: payParty(3) }
  const signers = { d: debtParty(2), c: debtParty(3) }
  const session = new Uint8Array(32).fill(0x5e)
  const clock = { now: NOW + 20 }
  const make = async (who: 'd' | 'c', index: number) => {
    const db = createNodeDb()
    await migrate(db)
    return { db, index, who }
  }
  const [d, c] = [await make('d', 1), await make('c', 2)]
  const tabs: Uint8Array[] = []
  for (const [k, amount] of remaining.entries()) {
    const tab = sha256(concatBytes(keys.d.key, keys.c.key, Uint8Array.of(k)))
    tabs.push(tab)
    if (k > 0) continue
    const first = coSigned(
      iouOf(1, keys.d.key, keys.c.key, amount > 0n ? amount : 1n * U, { tab, mint: MINT }),
      signers.d,
      signers.c,
    )
    for (const side of [d, c]) {
      const peer = side === d ? keys.c.key : keys.d.key
      await openTab(side.db, { tab, secret: tabSecretOf(tab), peer, mint: MINT }, NOW)
      await saveCoSigned(side.db, first, NOW)
    }
  }
  const debtsOf = (who: 'd' | 'c', db: typeof d.db) => ({
    db,
    me: keys[who].key,
    mint: MINT,
    iouDomain: IOU_DOMAIN,
    sign: async (body: Uint8Array) => signers[who].sign(iouEnvelope(decodeIou(body), IOU_DOMAIN)),
    now: () => clock.now,
    random: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
  })
  const signer = createSoftSigner(keys.d)
  const tabFor = (who: 'd' | 'c', k: number): RemainderTab => ({
    tab: tabs[k],
    peer: who === 'd' ? 2 : 1,
    role: who === 'd' ? 'debtor' : 'creditor',
    remaining: remaining[k],
    peerKey: who === 'd' ? keys.c.key : keys.d.key,
    state: undefined as never,
  })
  const depsOf = (who: 'd' | 'c'): RemainderDeps => {
    const side = who === 'd' ? d : c
    return {
      db: side.db,
      now: () => clock.now,
      mint: MINT,
      session,
      debts: debtsOf(who, side.db),
      link: (peer) => net.link(side.index, peer),
      payContext: async () => payCtx(keys.d, { bond: o.debtorBacking === 0n ? 0n : undefined, now: clock.now }),
      payDeps: () => ({
        db: d.db,
        sign: signer.sign,
        authenticate: o.authenticate ?? (async () => true),
        noteDomain: NOTE_DOMAIN,
        now: () => clock.now,
      }),
      receiveContext: async () => ({
        receiver: receiverFor(keys.c, { now: clock.now }),
        db: c.db,
        limits: LIMITS,
        transport: 'nearby',
        request: null,
      }),
      requestFor: (tab) =>
        buildRequest({
          amount: tab.remaining,
          memo: '',
          owner: { type: 'device', key: keys.c.key },
          mint: MINT,
          attesters: [ATTESTER.id],
          now: clock.now,
          limits: { maxPayment: LIMITS.maxPayment, minWindow: 3600 },
        }),
      timeouts: { request: 300, repay: 300, payment: 300, receipt: 300 },
    }
  }
  const party = (who: 'd' | 'c') => {
    const side = who === 'd' ? d : c
    return {
      db: side.db,
      index: side.index,
      deps: depsOf(who),
      tab: tabFor(who, 0),
      tabs: remaining.map((_, k) => tabFor(who, k)),
      link: (peer: number) => net.link(side.index, peer),
      balance: async () =>
        balance(
          keys[who].key,
          await coSignedStates(side.db, tabs[0]),
          await appliedNettings(side.db, tabs[0]),
          await repayStatuses(side.db, tabs[0]),
        ),
      expectedBalance: async () =>
        expectedBalance(
          keys[who].key,
          await coSignedStates(side.db, tabs[0]),
          await appliedNettings(side.db, tabs[0]),
          await repayStatuses(side.db, tabs[0]),
        ),
      latestStates: () => coSignedStates(side.db, tabs[0]),
      sweepDeps: () => ({
        db: side.db,
        now: () => clock.now,
        noteState: async () => 'settling' as const,
        paymentWindowEnds: () => NOW + PAYMENT_WINDOW_SECS,
        receivedPayment: receivedPaymentIn(side.db),
      }),
      receivedPaymentLookup: receivedPaymentIn(side.db),
    }
  }
  const world = {
    net,
    host: { key: host.key },
    d: party('d'),
    c: party('c'),
    session,
    mint: MINT,
    clock,
    now: () => clock.now,
    windowEnd: NOW + PAYMENT_WINDOW_SECS,
    before: remaining[0],
    requestToHost: () => world.c.deps.requestFor({ ...world.c.tab, peerKey: host.key }),
    requestOf: async (reference: Uint8Array) => {
      const [row] = await d.db.all<{ request: Uint8Array }>('SELECT request FROM repay_notes WHERE reference = ?', [
        reference,
      ])
      return JSON.parse(new TextDecoder().decode(row.request))
    },
  }
  for (const side of [d, c])
    await createSession(side.db, {
      session,
      role: 1,
      myIndex: side.index,
      ephemeralSecret: new Uint8Array(32),
      now: NOW,
    })
  await collectRemainder(d.db, session, world.d.tabs)
  await collectRemainder(c.db, session, world.c.tabs)
  return world
}
