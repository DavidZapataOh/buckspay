import { sha256 } from '@noble/hashes/sha2.js'
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import vectors from '../../../anchor/crates/protocol/tests/vectors/v1.json'
import { type CoSignedIou, decodeCoSigned, type Iou, IouCause, iouEnvelope, verifyCoSigned } from '../../protocol'
import {
  acceptState,
  type AppliedNetting,
  balance,
  checkOffer,
  expectedBalance,
  intentChange,
  MAX_MEMO_BYTES,
  memoHash,
  nextState,
  type RepayStatus,
  SEQ_WINDOW,
  type TabChange,
  type TabContext,
  type TabIntent,
  type TabNow,
  TabRefusal,
} from './tab'
import {
  chain,
  coSigned,
  contentOf,
  IOU_DOMAIN,
  iouOf,
  MINT,
  NOTE_DOMAIN,
  type Party,
  party,
  TAB,
  ZERO,
} from './testing'

const [ana, ben, cai] = [party(0xa1), party(0xb1), party(0xc1)]
const C1 = new Uint8Array(32).fill(0xc1)
const C2 = new Uint8Array(32).fill(0xc2)
const M = new Uint8Array(32).fill(0x9e)
const TAB2 = new Uint8Array(32).fill(0x7b)
const idle: TabNow = { balance: 0n, pending: false }
const { Open, Outside, Repay } = IouCause

const reasonOf = (run: () => unknown) => {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof TabRefusal ? error.reason : `not a TabRefusal: ${String(error)}`
  }
}
/** Ben answering Ana, holding `held` co-signed states (the last is his latest). */
const benSees = (
  held: readonly CoSignedIou[],
  now: TabNow = idle,
  nextSeq = (held.at(-1)?.iou.seq ?? 0) + 1,
): TabContext => ({
  me: ben.key,
  peer: ana.key,
  mint: MINT,
  previous: held.at(-1) ?? null,
  held: held.map(contentOf),
  nextSeq,
  now,
  iouDomain: IOU_DOMAIN,
})
const by = (who: Party, iou: Iou, under = IOU_DOMAIN) => who.sign(iouEnvelope(iou, under))
const change = (
  debtor: Uint8Array,
  creditor: Uint8Array,
  amount: bigint,
  extra: Partial<TabChange> = {},
): TabChange => ({
  debtor,
  creditor,
  amount,
  due: 0,
  cause: Open,
  reference: ZERO,
  memo: memoHash(null),
  ...extra,
})
const note = (seq: number, status: RepayStatus['status'], extra: Partial<RepayStatus> = {}): RepayStatus => ({
  tab: TAB,
  seq,
  reference: M,
  payee: ana.key,
  reduction: 4n,
  status,
  ...extra,
})
const recorded = (cancel: bigint, debtor = ben.key, extra: Partial<AppliedNetting> = {}): AppliedNetting => ({
  content: C1,
  tab: TAB,
  baseSeq: 1,
  debtor,
  cancel,
  ...extra,
})
const intent = (kind: TabIntent['kind'], amount = 0n, memo: string | null = null): TabIntent => ({
  kind,
  amount,
  due: 0,
  memo,
})
/** Ben owes Ana 10 (seq 1), then Ben repays 4 with payment M (seq 2). */
const owedThenRepaid = () =>
  chain([
    { seq: 1, debtor: ben, creditor: ana, amount: 10n },
    { seq: 2, debtor: ben, creditor: ana, amount: 4n, cause: Repay, reference: M },
  ])

describe('building changes', () => {
  it('nextState_uses_given_seq_and_keeps_pair', () => {
    const first = nextState(
      null,
      1,
      change(ana.key, ben.key, 25n, { memo: memoHash('Dinner'), open: { tab: TAB, mint: MINT } }),
    )
    expect(first).toMatchObject({ seq: 1, tab: TAB, mint: MINT, amount: 25n, reference: ZERO })
    const prev = coSigned(first, ana, ben)
    const gap = nextState(prev, 4, change(ben.key, ana.key, 5n, { reference: C1 }))
    expect(gap).toMatchObject({ seq: 4, tab: TAB, mint: MINT, debtor: ben.key, creditor: ana.key })
    expect(gap.reference).toEqual(contentOf(prev))
    expect(reasonOf(() => nextState(prev, 1, change(ana.key, ben.key, 5n)))).toBe('stale')
    expect(reasonOf(() => nextState(prev, 5, change(ana.key, cai.key, 5n)))).toBe('wrong-peer')
    expect(reasonOf(() => nextState(null, 1, change(ana.key, ben.key, 5n)))).toBe('malformed')
    expect(reasonOf(() => nextState(prev, 5, change(ana.key, ben.key, 5n, { open: { tab: C1, mint: MINT } })))).toBe(
      'malformed',
    )
    expect(reasonOf(() => nextState(prev, 5, change(ana.key, ben.key, 5n, { cause: Repay })))).toBe('malformed')
    expect(nextState(prev, 5, change(ana.key, ben.key, 5n, { cause: Repay, reference: M })).reference).toEqual(M)
    expect(reasonOf(() => nextState(prev, 5, change(ana.key, ben.key, 0n)))).toBe('malformed')
    expect(memoHash(null)).toEqual(ZERO)
    expect(memoHash('Dinner')).toEqual(sha256(utf8ToBytes('Dinner')))
  })

  it('intent_change_builds_deltas_and_clear_uses_the_balance', () => {
    const owed = (b: bigint, pending = false): TabNow => ({ balance: b, pending })
    expect(intentChange(ana.key, ben.key, intent('lent', 25n, 'Dinner'), idle)).toMatchObject({
      debtor: ben.key,
      creditor: ana.key,
      amount: 25n,
      cause: Open,
      memo: memoHash('Dinner'),
    })
    expect(intentChange(ana.key, ben.key, intent('lent', 5n), owed(25n))).toMatchObject({
      debtor: ben.key,
      amount: 5n,
      cause: Open,
    })
    expect(intentChange(ana.key, ben.key, intent('borrowed', 30n), owed(25n))).toMatchObject({
      debtor: ana.key,
      creditor: ben.key,
      amount: 30n,
    })
    expect(intentChange(ana.key, ben.key, intent('repaid', 10n), owed(25n))).toMatchObject({
      debtor: ben.key,
      amount: 10n,
      cause: Outside,
    })
    expect(intentChange(ana.key, ben.key, intent('repaid', 3n), owed(-5n, true))).toMatchObject({
      debtor: ana.key,
      amount: 3n,
      cause: Outside,
    })
    expect(intentChange(ana.key, ben.key, intent('clear', 999n), owed(25n))).toMatchObject({
      debtor: ben.key,
      amount: 25n,
      cause: Outside,
    })
    expect(intentChange(ana.key, ben.key, intent('clear'), owed(-7n))).toMatchObject({
      debtor: ana.key,
      creditor: ben.key,
      amount: 7n,
    })
    const refusals: [TabIntent, TabNow, string][] = [
      [intent('repaid', 26n), owed(25n), 'amount'],
      [intent('repaid', 1n), owed(0n), 'amount'],
      [intent('clear'), owed(0n), 'amount'],
      [intent('clear'), owed(10n, true), 'pending'],
      [intent('lent', 0n), idle, 'amount'],
      [intent('lent', 2n ** 64n), idle, 'amount'],
      [intent('lent', 1n, 'é'.repeat(MAX_MEMO_BYTES / 2 + 1)), idle, 'memo'],
    ]
    for (const [i, now, reason] of refusals)
      expect(
        reasonOf(() => intentChange(ana.key, ben.key, i, now)),
        `${i.kind} ${i.amount}`,
      ).toBe(reason)
  })

  it('clear_refused_while_a_repay_is_settling', () => {
    const held = chain([{ seq: 4, debtor: ana, creditor: ben, amount: 10n }])
    const pending: TabNow = { balance: 10n, pending: true }
    const offer = (amount: bigint, cause: Iou['cause'] = Outside) =>
      iouOf(5, ana.key, ben.key, amount, { cause, reference: contentOf(held[0]) })
    const [whole, across, part, more] = [offer(10n), offer(15n), offer(4n), offer(3n, Open)]
    expect(reasonOf(() => checkOffer(whole, by(ana, whole), benSees(held, pending)))).toBe('pending')
    expect(reasonOf(() => checkOffer(across, by(ana, across), benSees(held, pending)))).toBe('pending')
    expect(reasonOf(() => checkOffer(part, by(ana, part), benSees(held, pending)))).toBeUndefined()
    expect(reasonOf(() => checkOffer(more, by(ana, more), benSees(held, pending)))).toBeUndefined()
    expect(
      reasonOf(() => checkOffer(whole, by(ana, whole), benSees(held, { balance: 10n, pending: false }))),
    ).toBeUndefined()
  })
})

describe('accepting offers', () => {
  const held = chain([{ seq: 3, debtor: ana, creditor: ben, amount: 10n }])
  const at = (seq: number, debtor = ana, creditor = ben, extra: Partial<Iou> = {}) =>
    iouOf(seq, debtor.key, creditor.key, 5n, { reference: contentOf(held[0]), ...extra })
  const next = at(4)

  it('acceptState_refuses_lower_seq_wrong_peer_wrong_mint_bad_sig', () => {
    const state = acceptState(next, by(ana, next), { ...benSees(held), signature: by(ben, next) })
    expect(verifyCoSigned(state, IOU_DOMAIN)).toBe(true)
    expect(state.debtorSig).toEqual(by(ana, next))
    const toAna = at(5, ben, ana)
    expect(acceptState(toAna, by(ana, toAna), { ...benSees(held), signature: by(ben, toAna) }).creditorSig).toEqual(
      by(ana, toAna),
    )
    const four = new Uint8Array(32).fill(4)
    const cases: [string, Iou, Uint8Array, string][] = [
      ['equal seq', at(3), by(ana, at(3)), 'stale'],
      ['lower seq', at(2), by(ana, at(2)), 'stale'],
      ['a third party offers', at(4, cai, ben), by(cai, at(4, cai, ben)), 'wrong-peer'],
      ['not naming me', at(4, ana, cai), by(ana, at(4, ana, cai)), 'wrong-peer'],
      ['other mint', at(4, ana, ben, { mint: four }), by(ana, at(4, ana, ben, { mint: four })), 'wrong-mint'],
      ['other tab', at(4, ana, ben, { tab: C1 }), by(ana, at(4, ana, ben, { tab: C1 })), 'not-following'],
      ['signed by someone else', next, by(cai, next), 'bad-signature'],
      ['signed under the note domain', next, by(ana, next, NOTE_DOMAIN), 'bad-signature'],
      ['amount 0', { ...next, amount: 0n }, by(ana, { ...next, amount: 0n }), 'malformed'],
    ]
    for (const [name, iou, sig, reason] of cases)
      expect(
        reasonOf(() => checkOffer(iou, sig, benSees(held))),
        name,
      ).toBe(reason)
    expect(reasonOf(() => acceptState(next, by(ana, next), { ...benSees(held), signature: by(cai, next) }))).toBe(
      'bad-signature',
    )
  })

  it('predecessor_must_be_a_held_cosigned_content', () => {
    const named = (reference: Uint8Array) => at(4, ana, ben, { reference })
    expect(reasonOf(() => checkOffer(named(ZERO), by(ana, named(ZERO)), benSees(held)))).toBe('not-following')
    expect(reasonOf(() => checkOffer(named(C2), by(ana, named(C2)), benSees(held)))).toBe('not-following')
    expect(reasonOf(() => checkOffer(next, by(ana, next), benSees(held)))).toBeUndefined()
    const first = iouOf(1, ana.key, ben.key, 5n, { reference: C2 })
    expect(reasonOf(() => checkOffer(first, by(ana, first), benSees([])))).toBe('not-following')
    const firstOk = iouOf(1, ana.key, ben.key, 5n)
    expect(reasonOf(() => checkOffer(firstOk, by(ana, firstOk), benSees([])))).toBeUndefined()
  })

  it('netting_cause_offer_is_refused', () => {
    const netting = { ...next, cause: IouCause.Netting, reference: C1 }
    expect(reasonOf(() => checkOffer(netting, by(ana, netting), benSees(held)))).toBe('malformed')
    expect(
      reasonOf(() => acceptState(netting, by(ana, netting), { ...benSees(held), signature: by(ben, netting) })),
    ).toBe('malformed')
  })

  it('repay_answerer_must_be_the_creditor', () => {
    const toBen = at(4, ana, ben, { cause: Repay, reference: M })
    expect(reasonOf(() => checkOffer(toBen, by(ana, toBen), benSees(held)))).toBeUndefined()
    const benIsDebtor = at(4, ben, ana, { cause: Repay, reference: M })
    expect(reasonOf(() => checkOffer(benIsDebtor, by(ana, benIsDebtor), benSees(held)))).toBe('wrong-peer')
    const noReference = at(4, ana, ben, { cause: Repay, reference: ZERO })
    expect(reasonOf(() => checkOffer(noReference, by(ana, noReference), benSees(held)))).toBe('malformed')
  })

  it('seq_jump_too_large_refused', () => {
    expect(SEQ_WINDOW).toBe(65_536)
    const edge = at(4 + SEQ_WINDOW)
    expect(reasonOf(() => checkOffer(edge, by(ana, edge), benSees(held, idle, 4)))).toBeUndefined()
    const beyond = at(4 + SEQ_WINDOW + 1)
    expect(reasonOf(() => checkOffer(beyond, by(ana, beyond), benSees(held, idle, 4)))).toBe('seq-jump')
  })

  it('replayed_lower_state_is_refused', () => {
    const more = chain([
      { seq: 3, debtor: ana, creditor: ben, amount: 10n },
      { seq: 5, debtor: ana, creditor: ben, amount: 1n },
    ])
    expect(reasonOf(() => checkOffer(more[0].iou, more[0].debtorSig, benSees(more)))).toBe('stale')
    expect(reasonOf(() => checkOffer(more[1].iou, more[1].debtorSig, benSees(more)))).toBe('stale')
  })

  it('cosigned_old_offer_adds_only_its_own_change', () => {
    const [s1] = chain([{ seq: 1, debtor: ben, creditor: ana, amount: 50n }])
    const old = iouOf(2, ben.key, ana.key, 5n, { reference: contentOf(s1) })
    const s2 = acceptState(old, by(ana, old), {
      ...benSees([s1], { balance: -30n, pending: false }),
      signature: by(ben, old),
    })
    const netting = recorded(20n)
    expect(balance(ana.key, [s1, s2], [netting], [])).toBe(35n)
    expect(balance(ben.key, [s1, s2], [netting], [])).toBe(-35n)
    expect(balance(ana.key, [s2, s1, s2], [netting, netting], [])).toBe(35n)
  })
})

describe('balance', () => {
  it('balance_counts_a_recorded_netting_without_any_netting_state', () => {
    const states = chain([
      { seq: 1, debtor: ben, creditor: ana, amount: 50n },
      { seq: 7, debtor: ben, creditor: ana, amount: 10n, cause: Outside },
    ])
    expect(balance(ana.key, states.slice(0, 1), [], [])).toBe(50n)
    expect(balance(ana.key, states.slice(0, 1), [recorded(20n)], [])).toBe(30n)
    expect(balance(ben.key, states.slice(0, 1), [recorded(20n)], [])).toBe(-30n)
    expect(balance(ana.key, states.slice(0, 1), [recorded(20n), recorded(20n)], [])).toBe(30n)
    expect(balance(ana.key, states.slice(0, 1), [recorded(20n, ben.key, { tab: TAB2 })], [])).toBe(50n)
    expect(balance(ana.key, states, [recorded(20n)], [])).toBe(20n)
  })

  it('a_recorded_netting_conserves_each_phones_total', () => {
    const fromBen = chain([{ seq: 1, debtor: ben, creditor: ana, amount: 10n }])
    const toCai = chain([{ seq: 1, debtor: ana, creditor: cai, amount: 10n }], TAB2)
    const nettings = [recorded(5n, ben.key), recorded(5n, ana.key, { tab: TAB2 })]
    const total = (n: readonly AppliedNetting[]) => balance(ana.key, fromBen, n, []) + balance(ana.key, toCai, n, [])
    expect(total([])).toBe(0n)
    expect(total(nettings)).toBe(0n)
    expect(balance(ana.key, fromBen, nettings, [])).toBe(5n)
    expect(balance(ana.key, toCai, nettings, [])).toBe(-5n)
  })

  it('repay_counts_only_when_settled', () => {
    const states = owedThenRepaid()
    const cases: [RepayStatus[], bigint, bigint][] = [
      [[], 10n, 10n],
      [[note(2, 'settling')], 10n, 6n],
      [[note(2, 'settled')], 6n, 6n],
      [[note(2, 'void')], 10n, 10n],
      [[note(2, 'unknown')], 10n, 10n],
      [[note(2, 'undecided')], 10n, 10n],
      [[note(2, 'settled', { reference: C2 })], 10n, 10n],
    ]
    for (const [repays, counted, expected] of cases) {
      const label = repays.map((r) => r.status).join() || 'none'
      expect(balance(ana.key, states, [], repays), label).toBe(counted)
      expect(expectedBalance(ana.key, states, [], repays), label).toBe(expected)
    }
  })

  it('repay_with_a_conflicting_spend_counts_nothing', () => {
    // Ben double spent the note behind his Repay; the read is void and the debt stays in full, whatever comes later
    const states = owedThenRepaid()
    expect(balance(ana.key, states, [], [note(2, 'void')])).toBe(10n)
    expect(expectedBalance(ana.key, states, [], [note(2, 'void')])).toBe(10n)
    const more = chain([
      { seq: 1, debtor: ben, creditor: ana, amount: 10n },
      { seq: 2, debtor: ben, creditor: ana, amount: 4n, cause: Repay, reference: M },
      { seq: 3, debtor: ben, creditor: ana, amount: 1n },
    ])
    expect(balance(ana.key, more, [], [note(2, 'void')])).toBe(11n)
  })

  it('repay_reference_counts_once', () => {
    const states = chain([
      { seq: 1, debtor: ben, creditor: ana, amount: 10n },
      { seq: 2, debtor: ben, creditor: ana, amount: 4n, cause: Repay, reference: M },
      { seq: 3, debtor: ben, creditor: ana, amount: 4n, cause: Repay, reference: M },
    ])
    expect(balance(ana.key, states, [], [note(2, 'settled'), note(3, 'settled')])).toBe(6n)
  })

  it('void_repay_never_leaves_a_phantom_delta', () => {
    const states = chain([
      { seq: 1, debtor: ben, creditor: ana, amount: 10n },
      { seq: 2, debtor: ben, creditor: ana, amount: 4n, cause: Repay, reference: M },
      { seq: 3, debtor: ben, creditor: ana, amount: 10n, cause: Outside },
    ])
    expect(balance(ana.key, states, [], [note(2, 'void')])).toBe(0n)
    expect(balance(ana.key, states, [], [note(2, 'settled')])).toBe(-4n)
  })

  it('clear_after_a_void_repay_reaches_zero', () => {
    const states = owedThenRepaid()
    const now: TabNow = { balance: balance(ana.key, states, [], [note(2, 'void')]), pending: false }
    expect(now.balance).toBe(10n)
    const clear = nextState(states[1], 3, intentChange(ana.key, ben.key, intent('clear'), now))
    const after = [...states, coSigned(clear, ben, ana)]
    expect(balance(ana.key, after, [], [note(2, 'void')])).toBe(0n)
  })

  it('balance_refuses_two_bodies_in_one_slot', () => {
    const a = chain([{ seq: 2, debtor: ben, creditor: ana, amount: 4n }])
    const b = chain([{ seq: 2, debtor: ben, creditor: ana, amount: 9n }])
    expect(reasonOf(() => balance(ana.key, [...a, ...b], [], []))).toBe('malformed')
  })

  it('lost_accept_then_new_change_cannot_count_twice', () => {
    // Ana's +10 at seq 2 was co-signed by Ben but the accept was lost; she then made +10 again at seq 3, naming the same predecessor
    const [s1] = chain([{ seq: 1, debtor: ben, creditor: ana, amount: 25n }])
    const alt = (seq: number) => coSigned(iouOf(seq, ben.key, ana.key, 10n, { reference: contentOf(s1) }), ben, ana)
    expect(balance(ana.key, [s1, alt(2), alt(3)], [], [])).toBe(35n)
    expect(balance(ana.key, [s1, alt(3), alt(2)], [], [])).toBe(35n)
    // the golden vectors carry the same case: two alternatives on one predecessor, the higher seq counts
    const v = vectors.iou
    const states = v.states.map((s) => decodeCoSigned(hexToBytes(s.wire)))
    const pair = v.alternatives.states.map((w) => decodeCoSigned(hexToBytes(w)))
    const debtor = states[0].iou.debtor
    const counted = pair.find((p) => p.iou.seq === v.alternatives.counted_seq)!
    const creditorView = (list: CoSignedIou[]) => {
      const me = states[0].iou.creditor
      return balance(me, list, [], [])
    }
    const signedAmount = counted.iou.debtor.every((b, i) => b === debtor[i]) ? counted.iou.amount : -counted.iou.amount
    expect(creditorView([...states, ...pair]) - creditorView(states)).toBe(signedAmount)
  })

  it('withheld_accept_cosigned_later_is_outranked', () => {
    const [s1] = chain([{ seq: 1, debtor: ben, creditor: ana, amount: 25n }])
    const withheld = coSigned(iouOf(2, ben.key, ana.key, 7n, { reference: contentOf(s1) }), ben, ana)
    const replacement = coSigned(iouOf(3, ben.key, ana.key, 4n, { reference: contentOf(s1) }), ben, ana)
    const after = coSigned(iouOf(4, ben.key, ana.key, 1n, { reference: contentOf(replacement) }), ben, ana)
    expect(balance(ana.key, [s1, replacement, after], [], [])).toBe(30n)
    expect(balance(ana.key, [s1, replacement, after, withheld], [], [])).toBe(30n)
    expect(balance(ana.key, [s1, withheld], [], [])).toBe(32n)
  })
})
