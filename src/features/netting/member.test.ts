import { describe, expect, it } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  checkFinal,
  checkProposal,
  EXPIRES_SECS,
  EXPIRES_SKEW_SECS,
  GRIND_SECS,
  NettingRefusal,
  SIGN_MARGIN_SECS,
} from './member'
import { onCurveProposal, triangle } from './testing/proposal'

const refusal = async (run: () => unknown) => {
  try {
    await run()
  } catch (e) {
    return (e as NettingRefusal).code
  }
  throw new Error('expected a NettingRefusal')
}
const bump = (bytes: Uint8Array, i = 0) => Uint8Array.from(bytes, (b, j) => (j === i ? b ^ 1 : b))
const check = async (f: Awaited<ReturnType<typeof triangle>>, built = f.built, index = 1, now = f.now) =>
  checkProposal(built.proposal, f.rosterOfBuilt(built, index), await f.mineOf(index), now, f.deps)

describe('checkProposal (member B, index 1)', () => {
  it('accepts_an_honest_proposal_and_returns_the_view', async () => {
    const f = await triangle()
    const view = await check(f)
    expect(view.participants).toBe(3)
    expect(view.total).toBe(15_000_000n)
    expect(view.tabs.map((t) => [t.direction, t.amount, t.cancel, t.remaining])).toEqual(
      expect.arrayContaining([
        ['owesMe', 10_000_000n, 5_000_000n, 5_000_000n],
        ['iOwe', 7_000_000n, 5_000_000n, 2_000_000n],
      ]),
    )
    expect(view.netBefore).toBe(3_000_000n)
    expect(view.netAfter).toBe(view.netBefore)
  })

  it('member_refuses_proposal_changing_its_net', async () => {
    const f = await triangle()
    expect(await refusal(async () => check(f, f.rebuild({ cancel: { 'B>C': 6_000_000n } })))).toBe('NetChanged')
  })

  it('member_refuses_cancel_above_debt', async () => {
    const f = await triangle()
    expect(await refusal(async () => check(f, f.rebuild({ cancel: { 'A>B': 10_000_001n } })))).toBe('CancelAboveDebt')
  })

  it('member_refuses_a_slot_debt_that_is_not_its_own_balance', async () => {
    const f = await triangle()
    expect(await refusal(async () => check(f, f.rebuild({ debt: { 'A>B': 11_000_000n } })))).toBe('DigestMismatch')
  })

  it('member_takes_the_debt_from_its_balance_and_not_from_the_amount_of_its_latest_state', async () => {
    const f = await triangle()
    const mine = await f.mineOf(1)
    const skewed = {
      ...mine,
      tabs: mine.tabs.map((t) => ({
        ...t,
        state: { ...t.state, iou: { ...t.state.iou, amount: t.state.iou.amount + 1n } },
      })),
    }
    const view = checkProposal(f.built.proposal, f.rosterOfBuilt(f.built, 1), skewed, f.now, f.deps)
    expect(view.netBefore).toBe(3_000_000n)
  })

  it('member_refuses_digest_mismatch', async () => {
    const f = await triangle()
    const built = {
      ...f.built,
      proposal: { ...f.built.proposal, digests: f.built.proposal.digests.map((d, i) => (i === 1 ? bump(d) : d)) },
    }
    expect(await refusal(async () => check(f, built))).toBe('DigestMismatch')
  })

  it('member_refuses_root_not_from_digests', async () => {
    const f = await triangle()
    const statement = { ...f.built.proposal.statement, root: bump(f.built.proposal.statement.root, 31) }
    expect(await refusal(async () => check(f, { ...f.built, proposal: { ...f.built.proposal, statement } }))).toBe(
      'RootMismatch',
    )
  })

  it('member_accepts_a_lie_about_another_members_digest_because_that_member_checks_its_own', async () => {
    const f = await triangle()
    const lie = f.rebuild({ digestOverride: { 2: bump(f.built.proposal.digests[2]) } })
    await expect(check(f, lie, 1)).resolves.toBeDefined()
    expect(await refusal(async () => check(f, f.forMember(lie, 2), 2))).toBe('DigestMismatch')
  })

  it('member_refuses_counterparty_ephemeral_without_its_join', async () => {
    const f = await triangle()
    const forged = f.rebuild({ swapEphemeral: [2, new Uint8Array(32).fill(9)] })
    expect(await refusal(async () => check(f, forged))).toBe('CounterpartyJoin')
    const statement = {
      ...f.built.proposal.statement,
      ephemeral: f.built.proposal.statement.ephemeral.map((e, i) => (i === 2 ? new Uint8Array(32).fill(9) : e)),
    }
    expect(await refusal(async () => check(f, { ...f.built, proposal: { ...f.built.proposal, statement } }))).toBe(
      'CounterpartyJoin',
    )
  })

  it('member_refuses_a_join_whose_signature_is_not_by_that_device', async () => {
    const f = await triangle()
    const roster = f
      .rosterOf(1)
      .map((e) => (e.index === 2 ? { ...e, join: { ...e.join, signature: bump(e.join.signature, 5) } } : e))
    expect(await refusal(async () => checkProposal(f.built.proposal, roster, await f.mineOf(1), f.now, f.deps))).toBe(
      'CounterpartyJoin',
    )
  })

  it('member_accepts_a_roster_holding_only_its_own_and_its_counterparties_joins', async () => {
    const f = await triangle()
    expect(
      f
        .rosterOf(1)
        .map((e) => e.index)
        .sort(),
    ).toEqual([0, 1, 2])
    const four = await triangle({ people: 4 })
    const mine = await four.mineOf(1)
    const roster = four.rosterOf(1)
    expect(roster.length).toBeLessThan(4)
    expect(() => checkProposal(four.built.proposal, roster, mine, four.now, four.deps)).not.toThrow()
  })

  it('member_refuses_a_roster_missing_the_join_of_a_counterparty', async () => {
    const f = await triangle()
    const roster = f.rosterOf(1).filter((e) => e.index !== 2)
    expect(await refusal(async () => checkProposal(f.built.proposal, roster, await f.mineOf(1), f.now, f.deps))).toBe(
      'CounterpartyJoin',
    )
  })

  it('member_refuses_slot_not_at_its_index_pair', async () => {
    const f = await triangle()
    const slots = f.built.proposal.slots.map((s, i) => (i === 0 ? { ...s, slot: (s.slot + 1) % 28 } : s))
    expect(await refusal(async () => check(f, { ...f.built, proposal: { ...f.built.proposal, slots } }))).toBe(
      'WrongSlot',
    )
  })

  it('member_refuses_slot_for_a_tab_it_does_not_hold', async () => {
    const f = await triangle()
    const slots = [...f.built.proposal.slots, { slot: 27, baseSeq: 1, cancel: 1n }]
    expect(await refusal(async () => check(f, { ...f.built, proposal: { ...f.built.proposal, slots } }))).toBe(
      'UnknownTab',
    )
  })

  it('member_refuses_stale_seq', async () => {
    const f = await triangle()
    const slots = f.built.proposal.slots.map((s, i) => (i === 0 ? { ...s, baseSeq: s.baseSeq + 1 } : s))
    expect(await refusal(async () => check(f, { ...f.built, proposal: { ...f.built.proposal, slots } }))).toBe(
      'StaleSeq',
    )
  })

  it('member_refuses_a_tab_with_a_pending_item', async () => {
    const f = await triangle({ pending: ['A>B'] })
    expect(await refusal(async () => check(f))).toBe('PendingItem')
  })

  it('member_refuses_after_expires_margin', async () => {
    const f = await triangle()
    const { expires } = f.built.proposal.statement
    expect(await refusal(async () => check(f, f.built, 1, expires - SIGN_MARGIN_SECS))).toBe('Expired')
    expect(await refusal(async () => check(f, f.built, 1, expires + 1))).toBe('Expired')
    await expect(check(f, f.built, 1, expires - SIGN_MARGIN_SECS - 1)).resolves.toBeDefined()
  })

  it('member_refuses_expiry_beyond_three_days_plus_grind', async () => {
    const f = await triangle()
    const limit = f.now + EXPIRES_SECS + GRIND_SECS + EXPIRES_SKEW_SECS
    expect(await refusal(async () => check(f, f.rebuild({ expires: limit + 1 })))).toBe('ExpiresTooFar')
    await expect(check(f, f.rebuild({ expires: f.now + EXPIRES_SECS + GRIND_SECS }))).resolves.toBeDefined()
  })

  it('member_one_hour_behind_accepts_the_proposal', async () => {
    const f = await triangle()
    await expect(check(f, f.built, 1, f.now - EXPIRES_SKEW_SECS)).resolves.toBeDefined()
    expect(await refusal(async () => check(f, f.built, 1, f.now - EXPIRES_SKEW_SECS - 600))).toBe('ExpiresTooFar')
  })

  it('member_refuses_statement_address_on_curve', async () => {
    const f = await onCurveProposal()
    expect(await refusal(async () => check(f))).toBe('AddressOnCurve')
  })

  it('member_refuses_other_mint', async () => {
    const f = await triangle()
    expect(await refusal(async () => check(f, f.rebuild({ mint: new Uint8Array(32).fill(4) })))).toBe('WrongMint')
  })

  it('member_refuses_roster_without_itself', async () => {
    const f = await triangle()
    const others = f.rosterOf(1).filter((e) => e.index !== 1)
    expect(await refusal(async () => checkProposal(f.built.proposal, others, await f.mineOf(1), f.now, f.deps))).toBe(
      'NotInRoster',
    )
    const moved = f.rosterOf(1).map((e) => (e.index === 1 ? { ...e, index: 2 } : e))
    expect(await refusal(async () => checkProposal(f.built.proposal, moved, await f.mineOf(1), f.now, f.deps))).toBe(
      'DuplicateKey',
    )
  })

  it('member_refuses_duplicate_ephemeral_keys', async () => {
    const f = await triangle()
    const e = f.built.proposal.statement.ephemeral
    const statement = { ...f.built.proposal.statement, ephemeral: [e[0], e[1], e[0]] }
    expect(await refusal(async () => check(f, { ...f.built, proposal: { ...f.built.proposal, statement } }))).toBe(
      'BadStatement',
    )
  })

  it('member_refuses_total_below_its_own_cancels', async () => {
    const f = await triangle()
    const statement = { ...f.built.proposal.statement, total: 4_999_999n }
    expect(await refusal(async () => check(f, { ...f.built, proposal: { ...f.built.proposal, statement } }))).toBe(
      'TotalBelowMine',
    )
  })

  it('second_statement_on_same_base_refused', async () => {
    const f = await triangle()
    const mine = await f.mineOf(1)
    const taken = new Map(mine.tabs.map((t) => [`${bytesToHex(t.tab)}:${t.finalSeq}`, 'ff'.repeat(32)]))
    expect(
      await refusal(async () =>
        checkProposal(f.built.proposal, f.rosterOf(1), { ...mine, signedBases: taken }, f.now, f.deps),
      ),
    ).toBe('BaseSigned')
  })

  it('consent_view_shows_due_dates', async () => {
    const f = await triangle({ due: { 'A>B': 1_800_000_000, 'B>C': 0 } })
    const view = await check(f)
    expect(view.tabs.find((t) => t.direction === 'owesMe')?.due).toBe(1_800_000_000)
    expect(view.tabs.find((t) => t.direction === 'iOwe')?.due).toBe(0)
  })

  it('a_tab_missing_from_the_slots_counts_as_cancel_zero_and_the_net_still_has_to_hold', async () => {
    const f = await triangle()
    const none = f.rebuild({ cancel: { 'A>B': 0n, 'B>C': 0n, 'C>A': 0n } })
    expect((await check(f, none)).tabs.every((t) => t.cancel === 0n)).toBe(true)
    expect(await refusal(async () => check(f, f.rebuild({ cancel: { 'A>B': 0n } })))).toBe('NetChanged')
  })
})

describe('checkFinal', () => {
  const setup = async () => {
    const f = await triangle()
    const { statement } = f.built.proposal
    return { f, statement, signatures: await f.sign(statement), proof: new Uint8Array(256).fill(1) }
  }
  const yes = async () => true
  const no = async () => false

  it('accepts_the_full_set_with_a_valid_proof', async () => {
    const { f, statement, signatures, proof } = await setup()
    expect(await checkFinal(statement, signatures, proof, { domains: f.deps.domains, verifyProof: yes })).toEqual({
      setComplete: true,
      proof: 'valid',
    })
  })

  it('refuses_a_missing_or_an_extra_signature', async () => {
    const { f, statement, signatures, proof } = await setup()
    const deps = { domains: f.deps.domains, verifyProof: yes }
    expect(await refusal(() => checkFinal(statement, signatures.slice(0, 2), proof, deps))).toBe('BadSignatures')
    expect(await refusal(() => checkFinal(statement, [...signatures, signatures[0]], proof, deps))).toBe(
      'BadSignatures',
    )
  })

  it('refuses_signatures_in_the_wrong_order_or_by_the_wrong_key', async () => {
    const { f, statement, signatures, proof } = await setup()
    const deps = { domains: f.deps.domains, verifyProof: yes }
    expect(await refusal(() => checkFinal(statement, [signatures[1], signatures[0], signatures[2]], proof, deps))).toBe(
      'BadSignatures',
    )
    expect(
      await refusal(() => checkFinal(statement, [signatures[0], signatures[1], bump(signatures[2])], proof, deps)),
    ).toBe('BadSignatures')
  })

  it('refuses_a_set_signed_over_another_statement', async () => {
    const { f, statement, proof } = await setup()
    const signatures = await f.sign({ ...statement, total: statement.total + 1n })
    expect(
      await refusal(() => checkFinal(statement, signatures, proof, { domains: f.deps.domains, verifyProof: yes })),
    ).toBe('BadSignatures')
  })

  it('small_order_ephemeral_refused_by_checkFinal', async () => {
    const { f, statement, proof } = await setup()
    const identity = Uint8Array.of(1, ...new Uint8Array(31))
    const weak = { ...statement, ephemeral: [identity, statement.ephemeral[1], statement.ephemeral[2]] }
    expect(
      await refusal(() =>
        checkFinal(weak, new Array(3).fill(new Uint8Array(64)), proof, { domains: f.deps.domains, verifyProof: yes }),
      ),
    ).toBe('BadSignatures')
  })

  it('flags_an_invalid_or_missing_proof_but_the_set_is_still_complete', async () => {
    const { f, statement, signatures, proof } = await setup()
    expect(await checkFinal(statement, signatures, proof, { domains: f.deps.domains, verifyProof: no })).toEqual({
      setComplete: true,
      proof: 'invalid',
    })
    const throwing = async () => {
      throw new Error('verifier crashed')
    }
    expect(
      (await checkFinal(statement, signatures, proof, { domains: f.deps.domains, verifyProof: throwing })).proof,
    ).toBe('invalid')
    let called = false
    const spy = async () => {
      called = true
      return true
    }
    expect(
      await checkFinal(statement, signatures, new Uint8Array(256), { domains: f.deps.domains, verifyProof: spy }),
    ).toEqual({ setComplete: true, proof: 'missing' })
    expect(called).toBe(false)
  })
})
