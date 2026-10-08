import { describe, expect, it } from 'vitest'
import { type CoSignedIou, encodeCoSigned, encodeIou, type Iou, IouCause, iouEnvelope } from '../../protocol'
import { createLoopbackPair } from '../../transport/testing/loopback'
import { type Transport, TransportError } from '../../transport/types'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { DebtMessageType, DeclineReason, decodeDebtMessage, type OfferView, offerChange } from './exchange'
import {
  answerTabOffer,
  type DebtsContext,
  type HeldPayment,
  proposeRepay,
  proposeTabChange,
  resendPending,
} from './flow'
import {
  coSignedStates,
  latestFinal,
  lockTabs,
  pendingProposal,
  repayStatuses,
  saveCoSigned,
  setRepayStatus,
  statesOf,
  tabNow,
  tabSecret,
  tabWith,
  takeNextSeq,
} from './store'
import { memoHash, type TabIntent } from './tab'
import { contentOf, IOU_DOMAIN, iouOf, MINT, type Party, party, signerFor, ZERO } from './testing'

const NOW = 1_800_000_000
const [ana, ben] = [party(0xa1), party(0xb1)]
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const lent = (amount: bigint, memo: string | null = null): TabIntent => ({ kind: 'lent', amount, due: 0, memo })
const borrowed = (amount: bigint): TabIntent => ({ kind: 'borrowed', amount, due: 0, memo: null })

async function phone(who: Party, fill: number): Promise<DebtsContext> {
  const db = createNodeDb()
  await migrate(db)
  let next = fill
  return {
    db,
    me: who.key,
    mint: MINT,
    iouDomain: IOU_DOMAIN,
    sign: signerFor(who),
    now: () => NOW,
    random: (n) => new Uint8Array(n).fill(next++),
  }
}

function reviewer(answer = true) {
  const views: OfferView[] = []
  return { views, review: async (view: OfferView) => (views.push(view), answer) }
}

const same = (t: Transport) => t
const intercept = (
  t: Transport,
  hooks: { send?: (type: number) => void; drop?: (type: number) => boolean },
): Transport =>
  new Proxy(t, {
    get(target, prop, receiver) {
      if (prop === 'send' && hooks.send)
        return async (m: Parameters<Transport['send']>[0], o?: Parameters<Transport['send']>[1]) => {
          hooks.send?.(decodeDebtMessage(m).type)
          return target.send(m, o)
        }
      if (prop === 'receive' && hooks.drop)
        return async (o?: Parameters<Transport['receive']>[0]) => {
          for (;;) {
            const m = await target.receive(o)
            if (!hooks.drop?.(decodeDebtMessage(m).type)) return m
          }
        }
      return Reflect.get(target, prop, receiver)
    },
  })

/** One offer and its answer over a loopback pair; whichever side ends first, the other gets one tick and is then cancelled (a proposer refusing locally sends nothing). */
async function round(
  a: DebtsContext,
  b: DebtsContext,
  run: (t: Transport, s: AbortSignal) => Promise<unknown>,
  review = reviewer().review,
  wrap = { a: same, b: same },
) {
  const [ta, tb] = createLoopbackPair()
  const controller = new AbortController()
  const answered = answerTabOffer(b, wrap.b(tb), review, controller.signal)
  const proposed = run(wrap.a(ta), controller.signal)
  const answeredDone = Promise.allSettled([answered]).then(([r]) => r)
  const proposedDone = Promise.allSettled([proposed]).then(([r]) => r)
  await Promise.race([answeredDone, proposedDone])
  await tick()
  controller.abort()
  return { answered: await answeredDone, proposed: await proposedDone }
}
const propose = (
  a: DebtsContext,
  b: DebtsContext,
  intent: TabIntent,
  review?: (v: OfferView) => Promise<boolean>,
  wrap?: { a: typeof same; b: typeof same },
) => round(a, b, (t, s) => proposeTabChange(a, t, b.me, intent, s), review, wrap)

async function balanceOf(ctx: DebtsContext, peer: Uint8Array) {
  const row = await tabWith(ctx.db, peer, MINT)
  return row ? (await tabNow(ctx.db, ctx.me, row.tab)).balance : 0n
}

async function finals(a: DebtsContext, b: DebtsContext) {
  const [ra, rb] = [await tabWith(a.db, b.me, MINT), await tabWith(b.db, a.me, MINT)]
  return { a: ra && (await latestFinal(a.db, ra.tab)), b: rb && (await latestFinal(b.db, rb.tab)), ra, rb }
}

/** Content of `ctx`'s latest co-signed state with `peer` (zero when none): what an offer names as predecessor and `final_content`. */
async function latestContent(ctx: DebtsContext, peer: Uint8Array) {
  const row = await tabWith(ctx.db, peer, MINT)
  const latest = row && (await latestFinal(ctx.db, row.tab))
  return latest ? contentOf(latest) : ZERO
}

/** Ana sends a hand-made offer; `final_content` is her real latest content unless given. */
const craft = async (
  a: DebtsContext,
  b: DebtsContext,
  iou: Iou,
  extra: { secret?: Uint8Array | null; memo?: string | null; finalContent?: Uint8Array } = {},
  review = reviewer().review,
) => {
  const finalContent = extra.finalContent ?? (await latestContent(a, b.me))
  const adopt = async (states: CoSignedIou[]) => {
    for (const state of states) await saveCoSigned(a.db, state, NOW)
  }
  return round(
    a,
    b,
    (t, s) =>
      offerChange(
        t,
        {
          body: encodeIou(iou),
          signature: ana.sign(iouEnvelope(iou, IOU_DOMAIN)),
          finalContent,
          secret: extra.secret ?? null,
          memo: extra.memo ?? null,
          me: ana.key,
          iouDomain: IOU_DOMAIN,
          adopt,
        },
        s,
      ),
    review,
  )
}

describe('bilateral exchange', () => {
  it('offer_accept_over_loopback_stores_cosigned_on_both', async () => {
    const [a, b] = [await phone(ana, 0x10), await phone(ben, 0x60)]
    const r = reviewer()
    const { proposed, answered } = await propose(a, b, lent(25_000_000n, 'Dinner'), r.review)
    expect([proposed.status, answered.status]).toEqual(['fulfilled', 'fulfilled'])
    const f = await finals(a, b)
    expect(f.ra?.tab).toEqual(f.rb?.tab)
    expect(await tabSecret(a.db, f.ra!.tab)).toEqual(await tabSecret(b.db, f.rb!.tab))
    expect(encodeCoSigned(f.a!)).toEqual(encodeCoSigned(f.b!))
    expect(f.a!.iou).toMatchObject({
      seq: 1,
      amount: 25_000_000n,
      debtor: ben.key,
      creditor: ana.key,
      memo: memoHash('Dinner'),
    })
    expect(r.views).toHaveLength(1)
    expect(r.views[0]).toMatchObject({ first: true, previous: null, memo: 'Dinner' })
    expect((await statesOf(b.db, f.rb!.tab))[0].memo).toBe('Dinner')
  })

  it('decline_leaves_last_state', async () => {
    const [a, b] = [await phone(ana, 0x10), await phone(ben, 0x60)]
    await propose(a, b, lent(25n))
    const { proposed, answered } = await propose(a, b, borrowed(30n), reviewer(false).review)
    expect(proposed).toMatchObject({ status: 'rejected', reason: { reason: DeclineReason.Declined } })
    expect(answered).toMatchObject({ status: 'fulfilled', value: null })
    const f = await finals(a, b)
    expect([f.a!.iou.seq, f.b!.iou.seq, f.a!.iou.amount, f.b!.iou.amount]).toEqual([1, 1, 25n, 25n])
    expect((await pendingProposal(a.db, f.ra!.tab))?.iou.seq).toBe(2)
    expect(await statesOf(b.db, f.rb!.tab)).toHaveLength(1)
  })

  it('reoffer_after_decline_uses_next_seq', async () => {
    const [a, b] = [await phone(ana, 0x10), await phone(ben, 0x60)]
    await propose(a, b, lent(25n))
    await propose(a, b, borrowed(30n), reviewer(false).review)
    const { ra } = await finals(a, b)
    expect((await propose(a, b, lent(5n))).proposed).toMatchObject({ status: 'rejected', reason: { reason: 'stale' } })
    await takeNextSeq(a.db, ra!.tab)
    expect(await pendingProposal(a.db, ra!.tab)).toBeNull()
    const { proposed } = await propose(a, b, lent(5n))
    expect(proposed.status).toBe('fulfilled')
    const f = await finals(a, b)
    expect([f.a!.iou.seq, f.b!.iou.seq, f.a!.iou.amount]).toEqual([4, 4, 5n])
    expect([await balanceOf(a, ben.key), await balanceOf(b, ana.key)]).toEqual([30n, -30n])
    expect(f.ra!.nextSeq).toBe(5)
    expect(f.rb!.nextSeq).toBeGreaterThanOrEqual(5)
    expect((await statesOf(a.db, ra!.tab)).map((s) => s.iou.seq)).toEqual([4, 2, 1])
  })
})

describe('bilateral exchange, failures', () => {
  it('first_offer_declined_then_reoffered_still_carries_the_secret', async () => {
    const [a, b] = [await phone(ana, 0x10), await phone(ben, 0x60)]
    await propose(a, b, lent(25n), reviewer(false).review)
    const { ra } = await finals(a, b)
    expect(await tabWith(b.db, ana.key, MINT)).toBeNull()
    const r = reviewer()
    await round(a, b, (t, s) => resendPending(a, t, ra!.tab, s), r.review)
    expect(r.views[0]).toMatchObject({ first: true })
    const f = await finals(a, b)
    expect(f.b!.iou.seq).toBe(1)
    expect(await tabSecret(b.db, f.rb!.tab)).toEqual(await tabSecret(a.db, ra!.tab))
  })

  it('lost_accept_is_retried_idempotently', async () => {
    const [a, b] = [await phone(ana, 0x10), await phone(ben, 0x60)]
    const first = reviewer()
    let dropped = false
    const lossy = (t: Transport) =>
      intercept(t, { drop: (type) => !dropped && type === DebtMessageType.TabAccept && (dropped = true) })
    const { proposed } = await propose(a, b, lent(25n), first.review, { a: lossy, b: same })
    expect(proposed).toMatchObject({ status: 'rejected', reason: expect.any(TransportError) })
    const { ra } = await finals(a, b)
    expect(await latestFinal(a.db, ra!.tab)).toBeNull()
    const again = reviewer()
    await round(a, b, (t, s) => resendPending(a, t, ra!.tab, s), again.review)
    expect(first.views).toHaveLength(1)
    expect(again.views).toHaveLength(0)
    const f = await finals(a, b)
    expect(encodeCoSigned(f.a!)).toEqual(encodeCoSigned(f.b!))
    expect(await statesOf(b.db, f.rb!.tab)).toHaveLength(1)
  })

  it('replayed_offer_after_cosign_answers_the_same_accept_without_a_new_state', async () => {
    const [a, b] = [await phone(ana, 0x10), await phone(ben, 0x60)]
    await propose(a, b, lent(25n))
    const { a: done, rb } = await finals(a, b)
    const r = reviewer()
    const { proposed } = await craft(a, b, done!.iou, {}, r.review)
    expect(proposed).toMatchObject({ status: 'fulfilled' })
    expect(r.views).toHaveLength(0)
    expect(await statesOf(b.db, rb!.tab)).toHaveLength(1)
  })

  it('memo_hash_mismatch_refused', async () => {
    const [a, b] = [await phone(ana, 0x10), await phone(ben, 0x60)]
    const r = reviewer()
    const tab = new Uint8Array(32).fill(0x77)
    const cases: [Iou, string | null][] = [
      [iouOf(1, ben.key, ana.key, 5n, { tab, memo: memoHash('Lunch') }), 'Dinner'],
      [iouOf(1, ben.key, ana.key, 5n, { tab }), 'Dinner'],
      [iouOf(1, ben.key, ana.key, 5n, { tab, memo: memoHash('Lunch') }), null],
    ]
    for (const [iou, memo] of cases) {
      const { proposed } = await craft(a, b, iou, { secret: new Uint8Array(32).fill(1), memo }, r.review)
      expect(proposed).toMatchObject({ status: 'rejected', reason: { reason: DeclineReason.Invalid } })
    }
    expect(r.views).toHaveLength(0)
    expect(await tabWith(b.db, ana.key, MINT)).toBeNull()
  })

  it('answerer_writes_state_before_the_accept_leaves', async () => {
    const [a, b] = [await phone(ana, 0x10), await phone(ben, 0x60)]
    const failing = (t: Transport) =>
      intercept(t, {
        send: (type) => {
          if (type === DebtMessageType.TabAccept) throw new TransportError('Interrupted')
        },
      })
    const { answered } = await propose(a, b, lent(25n), undefined, { a: same, b: failing })
    expect(answered.status).toBe('rejected')
    const f = await finals(a, b)
    expect(f.b!.iou.seq).toBe(1)
    expect(f.a).toBeNull()
  })

  it('answerer_reserves_seq_before_signing', async () => {
    const [a, b] = [await phone(ana, 0x10), await phone(ben, 0x60)]
    const seen: (number | undefined)[] = []
    const sign = b.sign
    b.sign = async (body) => {
      seen.push((await tabWith(b.db, ana.key, MINT))?.nextSeq)
      return sign(body)
    }
    await propose(a, b, lent(25n))
    await propose(a, b, lent(5n))
    expect(seen).toEqual([2, 3])
  })

  it('locked_tab_is_declined_and_stays_pending', async () => {
    const [a, b] = [await phone(ana, 0x10), await phone(ben, 0x60)]
    await propose(a, b, lent(25n))
    const { rb, ra } = await finals(a, b)
    await lockTabs(b.db, new Uint8Array(32).fill(0x5e), [rb!.tab])
    const { proposed } = await propose(a, b, lent(5n))
    expect(proposed).toMatchObject({ status: 'rejected', reason: { reason: DeclineReason.Locked } })
    expect((await pendingProposal(a.db, ra!.tab))?.iou.seq).toBe(2)
  })

  it('answerer_returns_missing_cosigned_states_and_both_balances_match', async () => {
    const [a, b] = [await phone(ana, 0x10), await phone(ben, 0x60)]
    await propose(a, b, lent(25n))
    let dropped = false
    const lossy = (t: Transport) =>
      intercept(t, { drop: (type) => !dropped && type === DebtMessageType.TabAccept && (dropped = true) })
    await propose(a, b, lent(10n), undefined, { a: lossy, b: same })
    const { ra } = await finals(a, b)
    expect([await balanceOf(a, ben.key), await balanceOf(b, ana.key)]).toEqual([25n, -35n])
    // Ana gives up on the lost offer and makes a new change: Ben is ahead, hands back seq 2 and declines
    await takeNextSeq(a.db, ra!.tab)
    const healed = await propose(a, b, lent(5n))
    expect(healed.proposed).toMatchObject({ status: 'rejected', reason: { reason: 'stale' } })
    expect([await balanceOf(a, ben.key), await balanceOf(b, ana.key)]).toEqual([35n, -35n])
    expect((await coSignedStates(a.db, ra!.tab)).map((x) => x.iou.seq)).toEqual([1, 2])
    // the person decides again against the healed balance: it counts once
    expect((await propose(a, b, lent(5n))).proposed.status).toBe('fulfilled')
    expect([await balanceOf(a, ben.key), await balanceOf(b, ana.key)]).toEqual([40n, -40n])
  })

  it('proposer_sends_missing_states_when_the_answerer_is_behind', async () => {
    const [a, b] = [await phone(ana, 0x10), await phone(ben, 0x60)]
    await propose(a, b, lent(25n))
    let dropped = false
    const lossy = (t: Transport) =>
      intercept(t, { drop: (type) => !dropped && type === DebtMessageType.TabAccept && (dropped = true) })
    await propose(a, b, lent(10n), undefined, { a: lossy, b: same })
    // Ben now offers a change naming seq 2, which Ana lacks: she declines Behind, Ben sends his states and the same offer again
    const r = reviewer()
    const { proposed, answered } = await propose(b, a, { kind: 'borrowed', amount: 4n, due: 0, memo: null }, r.review)
    expect([proposed.status, answered.status]).toEqual(['fulfilled', 'fulfilled'])
    expect(r.views).toHaveLength(1)
    expect([await balanceOf(a, ben.key), await balanceOf(b, ana.key)]).toEqual([39n, -39n])
    const f = await finals(a, b)
    expect(encodeCoSigned(f.a!)).toEqual(encodeCoSigned(f.b!))
  })

  it('stale_offer_and_another_tab_for_the_pair_are_declined', async () => {
    const [a, b] = [await phone(ana, 0x10), await phone(ben, 0x60)]
    await propose(a, b, lent(25n))
    await propose(a, b, lent(5n))
    const { ra } = await finals(a, b)
    const stale = iouOf(1, ben.key, ana.key, 99n, { tab: ra!.tab })
    expect((await craft(a, b, stale)).proposed).toMatchObject({
      status: 'rejected',
      reason: { reason: DeclineReason.Stale },
    })
    const second = iouOf(1, ben.key, ana.key, 1n, { tab: new Uint8Array(32).fill(0x99) })
    expect((await craft(a, b, second, { secret: new Uint8Array(32).fill(2) })).proposed).toMatchObject({
      status: 'rejected',
      reason: { reason: DeclineReason.OtherTab },
    })
  })
})

describe('repay before release', () => {
  const M = new Uint8Array(32).fill(0x9e)
  const held = (log: string[], amount: bigint, check?: () => Promise<void>): HeldPayment => ({
    messageId: M,
    amount,
    request: new TextEncoder().encode('{"issue":"00","spends":[]}'),
    async release() {
      await check?.()
      log.push('released')
    },
  })

  async function owing() {
    const [a, b] = [await phone(ana, 0x10), await phone(ben, 0x60)]
    await propose(a, b, lent(25n))
    const f = await finals(a, b)
    return { a, b, tabA: f.ra!.tab, tabB: f.rb!.tab }
  }

  it('repay_counts_only_after_its_note_settles', async () => {
    const { a, b, tabA, tabB } = await owing()
    const log: string[] = []
    const payment = held(log, 10n, async () => {
      expect((await latestFinal(b.db, tabB))?.iou).toMatchObject({ cause: IouCause.Repay, amount: 10n, reference: M })
      expect(await repayStatuses(b.db, tabB)).toHaveLength(1)
    })
    const { proposed } = await round(b, a, (t, s) => proposeRepay(b, t, ana.key, payment, s))
    expect(proposed.status).toBe('fulfilled')
    expect(log).toEqual(['released'])
    expect((await repayStatuses(a.db, tabA))[0]).toMatchObject({ status: 'settling', payee: ana.key, reduction: 10n })
    expect([await balanceOf(a, ben.key), await balanceOf(b, ana.key)]).toEqual([25n, -25n])
    expect((await tabNow(a.db, ana.key, tabA)).pending).toBe(true)
    await setRepayStatus(a.db, tabA, M, 'settled', NOW)
    await setRepayStatus(b.db, tabB, M, 'settled', NOW)
    expect([await balanceOf(a, ben.key), await balanceOf(b, ana.key)]).toEqual([15n, -15n])
  })

  it('no_payment_released_without_a_stored_cosigned_repay', async () => {
    const { a, b, tabB } = await owing()
    const log: string[] = []
    const declined = await round(b, a, (t, s) => proposeRepay(b, t, ana.key, held(log, 10n), s), reviewer(false).review)
    expect(declined.proposed).toMatchObject({ status: 'rejected', reason: { reason: DeclineReason.Declined } })
    let dropped = false
    const lossy = (t: Transport) =>
      intercept(t, { drop: (type) => !dropped && type === DebtMessageType.TabAccept && (dropped = true) })
    const lost = await round(b, a, (t, s) => proposeRepay(b, t, ana.key, held(log, 10n), s), undefined, {
      a: lossy,
      b: same,
    })
    expect(lost.proposed.status).toBe('rejected')
    expect(log).toEqual([])
    expect((await latestFinal(b.db, tabB))?.iou.cause).toBe(IouCause.Open)
    expect(await repayStatuses(b.db, tabB)).toEqual([])
  })

  it('bilateral_repay_offer_requires_reference_and_creditor_answerer', async () => {
    const { a, b, tabA, tabB } = await owing()
    const r = reviewer()
    // Ana offers a Repay that Ben would answer as its debtor: refused
    const benAsDebtor = iouOf(2, ben.key, ana.key, 5n, { tab: tabA, cause: IouCause.Repay, reference: M })
    expect((await craft(a, b, benAsDebtor, {}, r.review)).proposed).toMatchObject({
      status: 'rejected',
      reason: { reason: DeclineReason.Invalid },
    })
    // a Repay without a reference cannot be co-signed either (the body is refused before review)
    const valid = iouOf(3, ana.key, ben.key, 5n, { tab: tabA, cause: IouCause.Repay, reference: M })
    const body = encodeIou(valid)
    body.fill(0, 149, 181)
    const [ta, tb] = createLoopbackPair()
    const c = new AbortController()
    const answered = answerTabOffer(b, tb, r.review, c.signal)
    const offered = offerChange(
      ta,
      {
        body,
        signature: ana.sign(iouEnvelope(valid, IOU_DOMAIN)),
        finalContent: await latestContent(a, ben.key),
        secret: null,
        memo: null,
        me: ana.key,
        iouDomain: IOU_DOMAIN,
        adopt: async () => undefined,
      },
      c.signal,
    )
    await expect(offered).rejects.toMatchObject({ reason: DeclineReason.Invalid })
    await answered
    expect(r.views).toHaveLength(0)
    // Ben as creditor: accepted, and Ben wrote its note (payee Ben) before answering
    expect((await craft(a, b, valid, {}, r.review)).proposed.status).toBe('fulfilled')
    expect(await repayStatuses(b.db, tabB)).toEqual([
      { tab: tabB, seq: 3, reference: M, payee: ben.key, reduction: 5n, status: 'settling' },
    ])
  })

  it('clear_is_refused_by_the_answerer_while_pending', async () => {
    const { a, b, tabA } = await owing()
    await round(b, a, (t, s) => proposeRepay(b, t, ana.key, held([], 10n), s))
    const clear = await propose(b, a, { kind: 'clear', amount: 0n, due: 0, memo: null })
    expect(clear.proposed).toMatchObject({ status: 'rejected', reason: { reason: 'pending' } })
    // Ana's whole-balance Outside reaches Ben while his Repay is settling: declined; a partial one passes
    const predecessor = await latestContent(a, ben.key)
    const whole = iouOf(5, ben.key, ana.key, 25n, { tab: tabA, cause: IouCause.Outside, reference: predecessor })
    expect((await craft(a, b, whole)).proposed).toMatchObject({
      status: 'rejected',
      reason: { reason: DeclineReason.Locked },
    })
    const part = iouOf(6, ben.key, ana.key, 5n, { tab: tabA, cause: IouCause.Outside, reference: predecessor })
    expect((await craft(a, b, part)).proposed.status).toBe('fulfilled')
    expect(await balanceOf(b, ana.key)).toBe(-20n)
  })
})
