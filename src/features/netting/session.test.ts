import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { cancelCycles } from './cycles'
import { listTabs } from '../debts/store'
import { Status } from './session-store'
import { SessionType } from './messages'
import { rig, week, type Rig, type TabSpec } from './testing/group'

const U = 1_000_000n
const triangle: TabSpec[] = [
  { a: 0, b: 1, amount: 10n * U, debtor: 'a' },
  { a: 1, b: 2, amount: 7n * U, debtor: 'a' },
  { a: 2, b: 0, amount: 5n * U, debtor: 'a' },
]
const types = (r: Rig) => r.net.frames.map((f) => f.type)
const sums = (r: Rig) => Promise.all(r.people.map((_, i) => r.sumBalances(i)))
const statuses = (r: Rig) => Promise.all(r.people.map((_, i) => r.statusOf(i)))
const expiresOf = (r: Rig) =>
  r.decodeProposal(r.net.frames.find((f) => f.type === SessionType.Proposal)!.body).statement.expires

describe('a full session', () => {
  it('five_members_reach_agreed_with_unchanged_nets', async () => {
    const r = await rig(5, week(1))
    const before = await sums(r)
    const outcomes = await r.run()
    expect(outcomes.map((o) => o.status)).toEqual(Array(5).fill('agreed'))
    for (const o of outcomes) if (o.status === 'agreed') expect(o.view.netAfter).toBe(o.view.netBefore)
    expect(await statuses(r)).toEqual(Array(5).fill(Status.Agreed))
    expect(await sums(r)).toEqual(before)
  })

  it('a_week_of_debts_cancels_exactly_the_optimum_cycles_find', async () => {
    const specs = week(2)
    const r = await rig(5, specs)
    const outcomes = await r.run()
    const debts = specs.map((s, i) => ({
      id: String(i),
      debtor: s.debtor === 'a' ? s.a : s.b,
      creditor: s.debtor === 'a' ? s.b : s.a,
      amount: s.amount,
    }))
    const expected = cancelCycles(5, debts)
    const totals = outcomes.flatMap((o) => (o.status === 'agreed' ? [o.view.total] : []))
    expect(totals).toHaveLength(5)
    expect(totals.every((t) => t === expected.total)).toBe(true)
    expect(expected.total).toBeGreaterThan(0n)
  })

  it('agreed_changes_no_balance_and_recording_applies_it_to_every_tab_with_every_net_unchanged', async () => {
    const r = await rig(3, triangle)
    const before = await sums(r)
    await r.run()
    expect(await r.balance(1, 0)).toBe(10n * U)
    await r.recordFrom(0)
    await r.sweepAll()
    expect(await statuses(r)).toEqual([Status.Recorded, Status.Recorded, Status.Recorded])
    expect(await r.balance(1, 0)).toBe(5n * U)
    expect(await sums(r)).toEqual(before)
  })

  it('nothing_to_net_ends_without_a_statement_or_a_signature', async () => {
    const r = await rig(3, [
      { a: 0, b: 1, amount: 4n * U, debtor: 'a' },
      { a: 1, b: 2, amount: 4n * U, debtor: 'a' },
    ])
    expect((await r.run()).map((o) => o.status)).toEqual(['nothing', 'nothing', 'nothing'])
    expect(types(r)).not.toContain(SessionType.Proposal)
    for (const p of r.people) expect(await p.db.all('SELECT * FROM netting_bases')).toHaveLength(0)
  })

  it('nothing_to_net_still_tells_each_phone_who_its_tabs_are_with', async () => {
    const r = await rig(3, [
      { a: 0, b: 1, amount: 4n * U, debtor: 'a' },
      { a: 1, b: 2, amount: 4n * U, debtor: 'a' },
    ])
    const outcomes = await r.run()
    const peers = outcomes.map((o) =>
      o.status === 'nothing' ? o.peers.map((p) => [p.index, bytesToHex(p.key)]) : null,
    )
    const key = (i: number) => bytesToHex(r.people[i].party.key)
    expect(peers).toEqual([
      [[1, key(1)]],
      [
        [0, key(0)],
        [2, key(2)],
      ],
      [[1, key(1)]],
    ])
  })

  it('there_is_no_states_or_counterparts_traffic_and_those_types_are_refused', async () => {
    const r = await rig(3, triangle)
    await r.run()
    expect(types(r)).not.toContain(0x18)
    expect(types(r)).not.toContain(0x19)
    const r2 = await rig(3, triangle)
    r2.net.tap((f) =>
      f.type === SessionType.Approve && f.from === 2 ? { type: 0x18, body: new Uint8Array(1) } : undefined,
    )
    const outcomes = await r2.run()
    expect(r2.net.dropped).toContain(r2.endpointOf(2))
    expect(outcomes.some((o) => o.status === 'agreed')).toBe(false)
  })
})

describe('what the host cannot do', () => {
  it('approve_carries_only_the_ed25519_signature', async () => {
    const r = await rig(3, triangle)
    await r.run()
    for (const f of r.net.frames.filter((x) => x.type === SessionType.Approve)) expect(f.body).toHaveLength(64)
    const order = types(r)
    expect(order.lastIndexOf(SessionType.Approve)).toBeLessThan(order.indexOf(SessionType.Final))
  })

  it('host_cannot_apply_one_tab_without_full_set', async () => {
    const r = await rig(3, triangle)
    r.net.tap((f) => (f.type === SessionType.Approve && f.from === 2 ? null : undefined))
    const before = await sums(r)
    const outcomes = await r.run()
    expect(outcomes.some((o) => o.status === 'agreed')).toBe(false)
    expect(types(r)).not.toContain(SessionType.Final)
    await r.recordFrom(0)
    await r.sweepAll()
    expect(await statuses(r)).not.toContain(Status.Recorded)
    expect(await sums(r)).toEqual(before)
    expect(await r.balance(1, 0)).toBe(10n * U)
  })

  it('host_dropping_any_message_after_final_cannot_change_any_net', async () => {
    const r = await rig(3, triangle)
    const before = await sums(r)
    let seenFinal = false
    r.net.tap((f) => {
      if (f.type === SessionType.Final) seenFinal = true
      return seenFinal && ((f.from === 1 && f.to === 2) || (f.from === 2 && f.to === 1) || f.to === 2 || f.from === 2)
        ? null
        : undefined
    })
    await r.run()
    await r.recordFrom(0)
    await r.sweepAll()
    await r.bilateralChange(1, 1, 1n * U)
    await r.bilateralChange(1, 1, -1n * U)
    expect(await sums(r)).toEqual(before)
    expect(await r.balance(1, 1)).toBe(-2n * U)
  })

  it('stale_one_sided_offer_cosigned_after_final_does_not_undo_the_netting', async () => {
    const r = await rig(3, triangle)
    const offer = r.oneSidedOffer(1, 1, 1n * U)
    await r.run()
    await r.recordFrom(0)
    await r.sweepAll()
    await offer.cosign(2)
    expect(await r.balance(1, 1)).toBe(-(2n * U + 1n * U))
  })

  it('stale_offer_cosigned_after_a_newer_change_on_the_same_predecessor_is_outranked', async () => {
    const r = await rig(3, triangle)
    const offer = r.oneSidedOffer(1, 1, 1n * U)
    await r.run()
    await r.recordFrom(0)
    await r.sweepAll()
    await r.bilateralChange(1, 1, 4n * U)
    await offer.cosign(2)
    expect(await r.balance(1, 1)).toBe(-(2n * U + 4n * U))
  })

  it('a_change_built_from_the_pre_netting_amount_cannot_undo_it', async () => {
    const r = await rig(3, triangle)
    await r.run()
    expect(await r.clear(1, 0)).toEqual({ refused: 'pending' })
    await r.recordFrom(0)
    await r.sweepAll()
    const cleared = await r.clear(1, 0)
    expect('change' in cleared && cleared.change.amount).toBe(5n * U)
  })

  it('an_agreed_tab_allows_explicit_changes_but_refuses_clear', async () => {
    const r = await rig(3, triangle)
    await r.run()
    await r.bilateralChange(1, 0, 3n * U)
    expect(await r.clear(1, 0)).toEqual({ refused: 'pending' })
  })

  it('member_signs_nothing_p256_after_the_join', async () => {
    const r = await rig(3, triangle)
    await r.run()
    for (const i of [0, 1, 2]) expect(r.people[i].signLog()).toEqual(['join'])
  })

  it('member_flags_invalid_final_proof', async () => {
    const r = await rig(3, triangle, { prove: async () => new Uint8Array(256).fill(7), verify: async () => false })
    const outcomes = await r.run()
    expect(outcomes.every((o) => o.status === 'agreed' && o.proof === 'invalid')).toBe(true)
    expect(await statuses(r)).toEqual([Status.Agreed, Status.Agreed, Status.Agreed])
  })

  it('a_failed_proof_job_sends_a_zero_proof_and_the_host_resends_final_when_it_succeeds', async () => {
    let calls = 0
    const r = await rig(3, triangle, {
      prove: async () => {
        if (calls++ === 0) throw new Error('out of memory')
        return new Uint8Array(256).fill(9)
      },
    })
    const outcomes = await r.run()
    expect(outcomes.every((o) => o.status === 'agreed' && o.proof === 'missing')).toBe(true)
    const finals = r.net.frames.filter((f) => f.type === SessionType.Final && f.to === 1)
    expect(finals.length).toBeGreaterThanOrEqual(2)
    expect(finals.at(-1)!.body.slice(-256)).toEqual(new Uint8Array(256).fill(9))
    expect(r.events.some((e) => e.type === 'final' && e.proof === 'valid')).toBe(true)
  })

  it('host_sending_different_statements_to_members_never_yields_a_full_set', async () => {
    const r = await rig(3, triangle)
    r.net.tap((f) =>
      f.type === SessionType.Proposal && f.to === 2 ? { body: r.regrindExpires(f.body, 7) } : undefined,
    )
    const outcomes = await r.run()
    expect(outcomes.some((o) => o.status === 'agreed')).toBe(false)
    expect(types(r)).not.toContain(SessionType.Final)
  })

  it('host_lying_to_one_member_about_its_cancel_is_refused_and_nobody_agrees', async () => {
    const r = await rig(3, triangle)
    r.net.tap((f) =>
      f.type === SessionType.Proposal && f.to === 1 ? { body: r.withCancel(f.body, 0, 6n * U) } : undefined,
    )
    const outcomes = await r.run()
    expect(outcomes[1]).toEqual({ status: 'refused', refusal: 'NetChanged' })
    expect(outcomes.some((o) => o.status === 'agreed')).toBe(false)
    expect(r.people[1].signLog()).toEqual(['join'])
    expect(await r.people[1].db.all('SELECT * FROM netting_bases')).toHaveLength(0)
  })

  it('host_excludes_tab_with_disagreeing_ends', async () => {
    const specs: TabSpec[] = [...triangle]
    specs[1] = { ...specs[1], extra: { a: 2n * U } }
    const outcomes = await (await rig(3, specs)).run()
    expect(outcomes.every((o) => o.status === 'nothing')).toBe(true)
  })

  it('host_excludes_tab_due_beyond_90_days', async () => {
    const far = triangle.map((s, i) => (i === 0 ? { ...s, due: (now: number) => now + 91 * 86_400 } : s))
    expect((await (await rig(3, far)).run()).every((o) => o.status === 'nothing')).toBe(true)
    const near = triangle.map((s, i) => (i === 0 ? { ...s, due: (now: number) => now + 89 * 86_400 } : s))
    expect((await (await rig(3, near)).run()).every((o) => o.status === 'agreed')).toBe(true)
  })

  it('host_excludes_a_tab_with_a_pending_item', async () => {
    const first = await rig(3, triangle)
    await first.run()
    const second = await first.rerun([])
    expect((await second.run()).every((o) => o.status === 'nothing')).toBe(true)
  })

  it('host_gives_its_own_approval_only_through_the_same_check_and_consent_path', async () => {
    const seen: number[] = []
    const r = await rig(3, triangle, {
      consent: (i) => {
        seen.push(i)
        return i !== 0
      },
    })
    const outcomes = await r.run()
    expect(seen).toContain(0)
    expect(outcomes[0].status).toBe('abandoned')
    expect(r.people[0].signLog()).toEqual(['join'])
    expect(await r.people[0].db.all('SELECT * FROM netting_bases')).toHaveLength(0)
  })

  it('roster_frame_to_a_member_holds_only_its_counterparties_joins', async () => {
    const specs: TabSpec[] = [
      { a: 0, b: 1, amount: 5n * U, debtor: 'a' },
      { a: 1, b: 2, amount: 5n * U, debtor: 'a' },
      { a: 2, b: 0, amount: 5n * U, debtor: 'a' },
      { a: 3, b: 0, amount: 1n * U, debtor: 'a' },
    ]
    const r = await rig(4, specs)
    await r.run()
    const rosters = r.net.frames.filter((f) => f.type === SessionType.Roster)
    const to3 = rosters.find((f) => f.to === 3)!
    expect(decodeCount(to3.body)).toBe(2)
    expect(decodeIndexes(to3.body).sort()).toEqual([0, 3])
    const to1 = rosters.find((f) => f.to === 1)!
    expect(decodeIndexes(to1.body).sort()).toEqual([0, 1, 2])
  })
})

describe('the chain decides', () => {
  it('withheld_final_then_record_applies_to_every_tab', async () => {
    const r = await rig(3, triangle)
    const before = await sums(r)
    r.net.tap((f) => (f.type === SessionType.Final && f.to === 1 ? null : undefined))
    const outcomes = await r.run()
    expect([outcomes[0].status, outcomes[1].status, outcomes[2].status]).toEqual(['agreed', 'pending', 'agreed'])
    await r.recordFrom(0)
    await r.sweepAll()
    expect(await statuses(r)).toEqual([Status.Recorded, Status.Recorded, Status.Recorded])
    await r.bilateralChange(1, 1, 1n * U)
    expect(await sums(r)).toEqual(before.map((v, i) => (i === 1 ? v - 1n * U : i === 2 ? v + 1n * U : v)))
  })

  it('no_record_before_expires_voids_for_everyone_from_chain_reads', async () => {
    const r = await rig(3, triangle)
    await r.run()
    const expires = expiresOf(r)
    r.chain.advance(expires - r.chain.now - 1)
    await r.sweepAll()
    expect(await statuses(r)).toEqual([Status.Agreed, Status.Agreed, Status.Agreed])
    r.chain.advance(2)
    await r.sweepAll()
    expect(await statuses(r)).toEqual([Status.Void, Status.Void, Status.Void])
    expect(await r.balance(1, 0)).toBe(10n * U)
  })

  it('a_record_one_second_before_expires_lands_and_one_at_expires_does_not', async () => {
    const r = await rig(3, triangle)
    await r.run()
    const expires = expiresOf(r)
    r.chain.advance(expires - r.chain.now)
    await r.recordFrom(0)
    await r.sweepAll()
    expect(await statuses(r)).toEqual([Status.Void, Status.Void, Status.Void])
    const ok = await rig(3, triangle)
    await ok.run()
    ok.chain.advance(expiresOf(ok) - ok.chain.now - 1)
    await ok.recordFrom(0)
    await ok.sweepAll()
    expect(await statuses(ok)).toEqual([Status.Recorded, Status.Recorded, Status.Recorded])
  })

  it('void_by_local_clock_cannot_happen', async () => {
    const r = await rig(3, triangle, { skew: { 1: 10 * 86_400 } })
    await r.run()
    await r.sweepAll()
    expect(await r.statusOf(1)).toBe(Status.Agreed)
    expect(await r.balance(1, 0)).toBe(10n * U)
  })

  it('a_member_with_a_fast_clock_voids_nothing_and_still_sees_the_record', async () => {
    const r = await rig(3, triangle, { skew: { 2: 90_000 } })
    await r.run()
    await r.recordFrom(0)
    await r.sweepAll()
    expect(await statuses(r)).toEqual([Status.Recorded, Status.Recorded, Status.Recorded])
  })

  it('prefunded_record_address_without_a_full_set_applies_nothing', async () => {
    const r = await rig(3, triangle, { consent: (i) => i !== 2 })
    const before = await sums(r)
    await r.run()
    const proposal = r.decodeProposal(r.net.frames.find((f) => f.type === SessionType.Proposal)!.body)
    r.chain.fund(r.contentOf(proposal.statement))
    await r.sweepAll()
    expect(await statuses(r)).not.toContain(Status.Recorded)
    expect(await sums(r)).toEqual(before)
    r.chain.advance(expiresOf(r) - r.chain.now)
    await r.sweepAll()
    expect(await statuses(r)).not.toContain(Status.Recorded)
  })

  it('undecided_after_keep_window_without_history', async () => {
    const r = await rig(3, triangle)
    await r.run()
    r.chain.historyReachesBack = false
    r.chain.advance(expiresOf(r) - r.chain.now + 30 * 86_400 + 1)
    await r.sweepAll()
    expect(await statuses(r)).toEqual([Status.Undecided, Status.Undecided, Status.Undecided])
    await r.bilateralChange(1, 0, 1n * U)
    expect(await r.balance(1, 0)).toBe(10n * U + 1n * U)
    expect(await r.clear(1, 0)).toEqual({ refused: 'pending' })
  })

  it('after_the_keep_window_history_shows_a_closed_record_as_recorded_and_no_record_as_void', async () => {
    const withRecord = await rig(3, triangle)
    await withRecord.run()
    await withRecord.recordFrom(0)
    withRecord.chain.advance(expiresOf(withRecord) - withRecord.chain.now + 30 * 86_400 + 1)
    await withRecord.sweepAll()
    expect(await withRecord.statusOf(1)).toBe(Status.Recorded)
    const without = await rig(3, triangle)
    await without.run()
    without.chain.advance(expiresOf(without) - without.chain.now + 30 * 86_400 + 1)
    await without.sweepAll()
    expect(await without.statusOf(1)).toBe(Status.Void)
  })

  it('a_member_who_signed_and_lost_the_host_still_gets_the_netting_from_the_record', async () => {
    const r = await rig(3, triangle)
    r.net.tap((f) => {
      if (f.type === SessionType.Approve && f.from === 2) queueMicrotask(() => r.net.cut(2))
      return undefined
    })
    const outcomes = await r.run()
    expect(outcomes[2].status).toBe('pending')
    await r.recordFrom(0)
    await r.sweepAll()
    expect(await r.statusOf(2)).toBe(Status.Recorded)
    expect(await r.balance(2, 1)).toBe(2n * U)
  })

  it('host_resends_final_to_a_pending_member_in_a_later_session', async () => {
    const r = await rig(3, triangle)
    r.net.tap((f) => (f.type === SessionType.Final && f.to === 2 ? null : undefined))
    expect((await r.run())[2].status).toBe('pending')
    const later = await r.rerun([])
    await later.run()
    expect(await r.statusOf(2)).toBe(Status.Agreed)
  })
})

describe('people who say no or disappear', () => {
  it('member_declining_consent_signs_nothing_and_aborts_the_session', async () => {
    const r = await rig(4, [...triangle, { a: 3, b: 0, amount: U, debtor: 'a' }], { consent: (i) => i !== 2 })
    const outcomes = await r.run()
    expect(['refused', 'abandoned']).toContain(outcomes[2].status)
    expect(await r.people[2].db.all('SELECT * FROM netting_bases')).toHaveLength(0)
    expect(outcomes.some((o) => o.status === 'agreed')).toBe(false)
  })

  it('members_who_signed_before_a_decline_stay_pending_until_the_chain_decides', async () => {
    const r = await rig(3, triangle, {
      consent: async (i) => {
        if (i === 2) await new Promise((x) => setTimeout(x, 60))
        return i !== 2
      },
    })
    await r.run()
    expect(await r.statusOf(1)).toBe(Status.Approved)
    expect(await r.clear(1, 0)).toEqual({ refused: 'pending' })
    r.chain.advance(expiresOf(r) - r.chain.now + 1)
    await r.sweepAll()
    expect(await r.statusOf(1)).toBe(Status.Void)
    expect(await r.clear(1, 0)).toHaveProperty('change')
  })

  it('member_leaving_before_approve_restarts_without_it', async () => {
    const r = await rig(4, [...triangle, { a: 3, b: 0, amount: U, debtor: 'a' }], {
      consent: () => new Promise(() => {}),
    })
    r.net.cut(2)
    const first = await r.run()
    expect(first.some((o) => o.status === 'agreed')).toBe(false)
    for (const p of [r.people[0], r.people[1], r.people[3]])
      expect((await listTabs(p.db)).every((t) => t.row.lockedBy === null)).toBe(true)
    const second = await (await r.rerun([2])).run()
    expect(second.every((o) => o.status === 'nothing' || o.status === 'agreed')).toBe(true)
  })

  it('host_vanishing_before_the_proposal_abandons_the_members_and_unlocks_them', async () => {
    const r = await rig(3, triangle)
    r.net.tap((f) => {
      if (f.type === SessionType.Roster) queueMicrotask(() => r.net.cutHost())
      return undefined
    })
    const outcomes = await r.run()
    expect(outcomes.slice(1).every((o) => o.status === 'abandoned')).toBe(true)
    for (const p of r.people.slice(1)) expect((await listTabs(p.db)).every((t) => t.row.lockedBy === null)).toBe(true)
  })

  it('host_vanishing_after_approve_leaves_members_pending_then_void_from_the_chain', async () => {
    const r = await rig(3, triangle)
    r.net.tap((f) => {
      if (f.type === SessionType.Approve && f.to === 0 && f.from === 2) queueMicrotask(() => r.net.cutHost())
      return undefined
    })
    const outcomes = await r.run()
    expect(outcomes.slice(1).every((o) => o.status === 'pending')).toBe(true)
    r.chain.advance(expiresOf(r) - r.chain.now - 1)
    await r.sweepAll()
    expect(await r.statusOf(1)).toBe(Status.Approved)
    r.chain.advance(2)
    await r.sweepAll()
    expect(await r.statusOf(1)).toBe(Status.Void)
  })

  it('base_reusable_after_void_or_abandoned_session', async () => {
    const r = await rig(3, triangle)
    r.net.tap((f) => (f.type === SessionType.Final ? null : undefined))
    await r.run()
    const blocked = await (await r.rerun([])).run()
    expect(blocked.some((o) => o.status === 'agreed')).toBe(false)
    r.chain.advance(expiresOf(r) - r.chain.now)
    await r.sweepAll()
    r.chain.advance(1)
    await r.sweepAll()
    expect(await statuses(r)).toEqual([Status.Void, Status.Void, Status.Void])
    const again = await (await r.rerun([])).run()
    expect(again.every((o) => o.status === 'agreed')).toBe(true)
  })

  it('a_late_signature_is_refused_even_after_the_consent_screen_was_shown_in_time', async () => {
    const r = await rig(3, triangle, {
      consent: (_i, view, clock) => {
        clock.advance(view.expires - clock.now - 599)
        return true
      },
    })
    const outcomes = await r.run()
    expect(outcomes.some((o) => o.status === 'agreed')).toBe(false)
    expect(outcomes.filter((o) => o.status === 'refused' && o.refusal === 'Expired').length).toBeGreaterThan(0)
    expect(await r.people[1].db.all('SELECT * FROM netting_bases')).toHaveLength(0)
  })
})

describe('binding and simplification', () => {
  it('grinding_expires_recomputes_digests', async () => {
    const r = await rig(3, triangle, { forceCurveTries: 3 })
    const outcomes = await r.run()
    expect(r.events.filter((e) => e.type === 'grind').map((e) => (e as { tries: number }).tries)).toEqual([4])
    const { statement, digests } = r.decodeProposal(r.net.frames.find((f) => f.type === SessionType.Proposal)!.body)
    expect(statement.expires).toBeGreaterThan(r.clock.now + 72 * 3600 + 2)
    expect(r.recomputeRoot(statement, digests)).toEqual(statement.root)
    expect(r.recomputeDigest(statement, 0)).toEqual(digests[0])
    expect(outcomes.every((o) => o.status === 'agreed')).toBe(true)
  })

  // The payment along a path of tabs is not built yet, so there is nothing to approve or decline.
  it.skip('simplification_needs_every_via_member', async () => {
    const chain: TabSpec[] = [
      { a: 0, b: 1, amount: 5n * U, debtor: 'a' },
      { a: 1, b: 2, amount: 5n * U, debtor: 'a' },
      { a: 2, b: 3, amount: 5n * U, debtor: 'a' },
      { a: 3, b: 0, amount: 1n * U, debtor: 'b' },
    ]
    for (const decliner of [0, 1, 2, 3]) {
      const r = await rig(4, chain)
      await r.run()
      expect((await r.simplify((index) => index !== decliner)).paid).toBe(false)
    }
    const ok = await rig(4, chain)
    await ok.run()
    expect((await ok.simplify(() => true)).paid).toBe(true)
  })
})

describe('the wire is hostile', () => {
  it('replayed_frames_do_nothing', async () => {
    const r = await rig(3, triangle)
    r.net.duplicateEveryFrame()
    const outcomes = await r.run()
    expect(outcomes.every((o) => o.status === 'agreed')).toBe(true)
    for (const p of r.people) {
      expect(await p.db.all('SELECT * FROM netting_sessions')).toHaveLength(1)
      expect((await p.db.all('SELECT * FROM netting_effects')).length).toBeGreaterThan(0)
    }
  })

  it('replayed_frames_do_nothing_after_a_receiver_restart', async () => {
    const r = await rig(3, triangle)
    await r.run()
    const before = await Promise.all(r.people.map((p) => p.db.all('SELECT * FROM netting_sessions')))
    await r.restartHostChannel()
    for (const f of r.net.captured()) await r.net.inject(f)
    expect(await Promise.all(r.people.map((p) => p.db.all('SELECT * FROM netting_sessions')))).toEqual(before)
  })

  it('a_tampered_frame_drops_only_that_endpoint', async () => {
    const r = await rig(3, triangle)
    let flipped = false
    r.net.corrupt((f) => {
      if (!flipped && f.type === SessionType.Tabs && f.from === 2) {
        flipped = true
        return true
      }
      return false
    })
    const outcomes = await r.run()
    expect(r.net.dropped).toContain(r.endpointOf(2))
    expect(outcomes.some((o) => o.status === 'agreed')).toBe(false)
    expect(outcomes[1].status).toBe('abandoned')
  })

  it('an_insider_forging_a_sender_cannot_change_the_outcome', async () => {
    const r = await rig(4, [...triangle, { a: 3, b: 1, amount: U, debtor: 'a' }])
    r.net.insider(3, async (seal) => {
      await seal(2, SessionType.Approve, new Uint8Array(64).fill(9), 'to-host')
      await seal(0, SessionType.Abort, Uint8Array.of(1), 'to-member-1', 'after-approve')
    })
    const outcomes = await r.run()
    expect(outcomes.filter((o) => o.status === 'agreed').length).toBeGreaterThanOrEqual(3)
  })
})

const decodeCount = (body: Uint8Array) => body[0]
const decodeIndexes = (body: Uint8Array) => Array.from({ length: body[0] }, (_, k) => body[1 + 164 * k])
