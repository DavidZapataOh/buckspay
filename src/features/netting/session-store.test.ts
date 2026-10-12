import { describe, expect, it } from 'vitest'
import { listTabs } from '../debts/store'
import {
  adoptFinal,
  BaseTaken,
  createSession,
  ephemeralSecretOf,
  listSessions,
  loadSession,
  markApproved,
  markProposed,
  nettingPending,
  pursueRecord,
  SessionExists,
  Status,
  sweepSessions,
} from './session-store'
import { triangle } from './testing/proposal'

const yes = async () => true
const outcome = (value: 'recorded' | 'void' | 'pending' | 'undecided') => ({ nettingOutcome: async () => value })

async function approvedSession() {
  const f = await triangle()
  const b = f.people[1]
  await createSession(b.db, {
    session: f.session,
    role: 1,
    myIndex: 1,
    ephemeralSecret: f.built.ephemeralSecrets[1],
    now: f.now,
  })
  const mine = await f.mineOf(1)
  await markProposed(b.db, f.session, {
    statement: f.statementBytes,
    joins: f.rosterOf(1),
    digests: f.built.proposal.digests,
    leaves: f.leavesOf(1),
    myIndex: 1,
    now: f.now,
  })
  const content = f.contentOf(f.built.proposal.statement)
  const effects = f.built.proposal.slots.map((s) => ({
    tab: f.tabOfSlot(1, s.slot),
    baseSeq: s.baseSeq,
    debtor: f.debtorOfSlot(1, s.slot),
    cancel: s.cancel,
  }))
  return {
    f,
    b,
    mine,
    content,
    effects,
    statement: f.built.proposal.statement,
    signature: (await f.sign(f.built.proposal.statement))[1],
  }
}
const approve = (s: Awaited<ReturnType<typeof approvedSession>>) =>
  markApproved(s.b.db, s.f.session, s.content, s.effects, s.signature, s.f.now)
const deps = (s: Awaited<ReturnType<typeof approvedSession>>) => ({
  domains: s.f.deps.domains,
  now: () => s.f.now,
  verify: yes,
})

describe('session store', () => {
  it('createSession_refuses_an_existing_id', async () => {
    const s = await approvedSession()
    await expect(
      createSession(s.b.db, {
        session: s.f.session,
        role: 1,
        myIndex: 1,
        ephemeralSecret: new Uint8Array(32),
        now: s.f.now,
      }),
    ).rejects.toBeInstanceOf(SessionExists)
  })

  it('markApproved_writes_bases_effects_status_and_signature_in_one_transaction', async () => {
    const s = await approvedSession()
    await approve(s)
    const row = await loadSession(s.b.db, s.f.session)
    expect(row?.status).toBe(Status.Approved)
    expect(row?.signatures[1]).toEqual(s.signature)
    expect(await s.b.db.all('SELECT * FROM netting_bases')).toHaveLength(s.effects.length)
    expect(await s.b.db.all('SELECT * FROM netting_effects')).toHaveLength(s.effects.length)
    expect(
      (await s.b.db.all<{ content: Uint8Array }>('SELECT content FROM netting_bases')).every(
        (r) => r.content.length === 32,
      ),
    ).toBe(true)
  })

  it('markApproved_writes_nothing_when_any_statement_fails', async () => {
    const f = await triangle({ dbFailOn: (sql, n) => sql.startsWith('UPDATE netting_sessions') && n > 0 })
    const b = f.people[1]
    await createSession(b.db, {
      session: f.session,
      role: 1,
      myIndex: 1,
      ephemeralSecret: new Uint8Array(32).fill(1),
      now: f.now,
    })
    const effects = f.built.proposal.slots.map((sl) => ({
      tab: f.tabOfSlot(1, sl.slot),
      baseSeq: sl.baseSeq,
      debtor: f.debtorOfSlot(1, sl.slot),
      cancel: sl.cancel,
    }))
    await expect(
      markApproved(b.db, f.session, f.contentOf(f.built.proposal.statement), effects, new Uint8Array(64), f.now),
    ).rejects.toBeDefined()
    expect(await b.db.all('SELECT * FROM netting_bases')).toHaveLength(0)
    expect(await b.db.all('SELECT * FROM netting_effects')).toHaveLength(0)
    expect((await loadSession(b.db, f.session))?.status).toBe(Status.Joining)
  })

  it('base_reusable_after_void_or_abandoned_session', async () => {
    const s = await approvedSession()
    await approve(s)
    await sweepSessions(s.b.db, outcome('void'), s.f.now, { restart: false })
    const other = new Uint8Array(32).fill(0xdd)
    await createSession(s.b.db, {
      session: other,
      role: 1,
      myIndex: 1,
      ephemeralSecret: new Uint8Array(32).fill(3),
      now: s.f.now,
    })
    await expect(
      markApproved(s.b.db, other, new Uint8Array(32).fill(9), s.effects, s.signature, s.f.now),
    ).resolves.toBeUndefined()
    expect(await s.b.db.all('SELECT * FROM netting_bases')).toHaveLength(s.effects.length * 2)
  })

  it('markApproved_refuses_a_base_held_by_another_session', async () => {
    const s = await approvedSession()
    await approve(s)
    const other = new Uint8Array(32).fill(0xee)
    await createSession(s.b.db, {
      session: other,
      role: 1,
      myIndex: 1,
      ephemeralSecret: new Uint8Array(32).fill(2),
      now: s.f.now,
    })
    await expect(markApproved(s.b.db, other, s.content, s.effects, s.signature, s.f.now)).rejects.toBeInstanceOf(
      BaseTaken,
    )
    expect((await loadSession(s.b.db, other))?.status).toBe(Status.Joining)
  })

  it('second_statement_in_the_same_session_is_refused', async () => {
    const s = await approvedSession()
    await approve(s)
    await expect(
      markApproved(s.b.db, s.f.session, new Uint8Array(32).fill(7), s.effects, s.signature, s.f.now),
    ).rejects.toBeInstanceOf(BaseTaken)
  })

  it('markApproved_ends_the_consent_lock_and_marks_the_tabs_pending', async () => {
    const s = await approvedSession()
    expect(await nettingPending(s.b.db, s.effects[0].tab)).toBe(false)
    await approve(s)
    expect((await listTabs(s.b.db)).every((t) => t.row.lockedBy === null)).toBe(true)
    expect(await nettingPending(s.b.db, s.effects[0].tab)).toBe(true)
  })

  it('adoptFinal_stores_the_full_set_wipes_the_secret_and_makes_the_session_agreed_not_recorded', async () => {
    const s = await approvedSession()
    await approve(s)
    const signatures = await s.f.sign(s.statement)
    expect(
      await adoptFinal(s.b.db, deps(s), s.f.session, s.f.statementBytes, {
        signatures,
        proof: new Uint8Array(256).fill(1),
      }),
    ).toEqual({ setComplete: true, proof: 'valid' })
    expect((await loadSession(s.b.db, s.f.session))?.status).toBe(Status.Agreed)
    expect(await ephemeralSecretOf(s.b.db, s.f.session)).toBeNull()
    expect(await s.f.appliedNettingsOf(1)).toEqual([])
    expect(await nettingPending(s.b.db, s.effects[0].tab)).toBe(true)
  })

  it('adoptFinal_is_idempotent', async () => {
    const s = await approvedSession()
    await approve(s)
    const evidence = { signatures: await s.f.sign(s.statement), proof: new Uint8Array(256) }
    await adoptFinal(s.b.db, deps(s), s.f.session, s.f.statementBytes, evidence)
    const before = await loadSession(s.b.db, s.f.session)
    await adoptFinal(s.b.db, deps(s), s.f.session, s.f.statementBytes, evidence)
    expect(await loadSession(s.b.db, s.f.session)).toEqual(before)
  })

  it('adoptFinal_refuses_incomplete_or_forged_sets_and_changes_nothing', async () => {
    const s = await approvedSession()
    await approve(s)
    const signatures = await s.f.sign(s.statement)
    await expect(
      adoptFinal(s.b.db, deps(s), s.f.session, s.f.statementBytes, {
        signatures: signatures.slice(1),
        proof: new Uint8Array(256),
      }),
    ).rejects.toMatchObject({ code: 'BadSignatures' })
    expect((await loadSession(s.b.db, s.f.session))?.status).toBe(Status.Approved)
    expect(await ephemeralSecretOf(s.b.db, s.f.session)).not.toBeNull()
  })

  it('a_full_set_does_not_change_a_session_the_chain_already_voided', async () => {
    const s = await approvedSession()
    await approve(s)
    await sweepSessions(s.b.db, outcome('void'), s.f.now, { restart: false })
    await adoptFinal(s.b.db, deps(s), s.f.session, s.f.statementBytes, {
      signatures: await s.f.sign(s.statement),
      proof: new Uint8Array(256),
    })
    expect((await loadSession(s.b.db, s.f.session))?.status).toBe(Status.Void)
  })

  it('pending_member_finalizes_from_record', async () => {
    const s = await approvedSession()
    await approve(s)
    await expect(
      adoptFinal(s.b.db, deps(s), s.f.session, new Uint8Array(s.f.statementBytes.length), { recorded: true }),
    ).rejects.toMatchObject({ code: 'BadStatement' })
    expect((await loadSession(s.b.db, s.f.session))?.status).toBe(Status.Approved)
    await adoptFinal(s.b.db, deps(s), s.f.session, s.f.statementBytes, { recorded: true })
    expect((await loadSession(s.b.db, s.f.session))?.status).toBe(Status.Recorded)
    expect(await ephemeralSecretOf(s.b.db, s.f.session)).toBeNull()
    expect((await s.f.appliedNettingsOf(1)).length).toBe(s.effects.length)
  })

  it('sweep_marks_recorded_void_and_undecided_from_the_chain_read_only', async () => {
    for (const [read, status] of [
      ['recorded', Status.Recorded],
      ['void', Status.Void],
      ['undecided', Status.Undecided],
      ['pending', Status.Approved],
    ] as const) {
      const s = await approvedSession()
      await approve(s)
      await sweepSessions(s.b.db, outcome(read), s.f.now, { restart: false })
      expect((await loadSession(s.b.db, s.f.session))?.status).toBe(status)
    }
  })

  it('void_by_local_clock_cannot_happen', async () => {
    const s = await approvedSession()
    await approve(s)
    const wayLater = s.statement.expires + 30 * 86_400
    await sweepSessions(s.b.db, outcome('pending'), wayLater, { restart: false })
    expect((await loadSession(s.b.db, s.f.session))?.status).toBe(Status.Approved)
    await adoptFinal(s.b.db, deps(s), s.f.session, s.f.statementBytes, {
      signatures: await s.f.sign(s.statement),
      proof: new Uint8Array(256),
    })
    await sweepSessions(s.b.db, outcome('pending'), wayLater, { restart: false })
    expect((await loadSession(s.b.db, s.f.session))?.status).toBe(Status.Agreed)
    expect(await s.f.appliedNettingsOf(1)).toEqual([])
  })

  it('recorded_netting_counts_only_at_status_4', async () => {
    const s = await approvedSession()
    await approve(s)
    expect(await s.f.appliedNettingsOf(1)).toEqual([])
    await sweepSessions(s.b.db, outcome('recorded'), s.f.now, { restart: false })
    expect((await s.f.appliedNettingsOf(1)).map((n) => n.cancel).sort()).toEqual(s.effects.map((e) => e.cancel).sort())
    expect(await nettingPending(s.b.db, s.effects[0].tab)).toBe(false)
  })

  it('restart_abandons_joining_and_proposed_sessions_but_keeps_an_approved_one', async () => {
    const s = await approvedSession()
    await sweepSessions(s.b.db, outcome('pending'), s.f.now, { restart: true })
    expect((await loadSession(s.b.db, s.f.session))?.status).toBe(Status.Abandoned)
    const t = await approvedSession()
    await approve(t)
    await sweepSessions(t.b.db, outcome('pending'), t.f.now, { restart: true })
    expect((await loadSession(t.b.db, t.f.session))?.status).toBe(Status.Approved)
  })

  it('ephemeral_secret_is_wiped_at_agreed_void_and_abandoned_and_not_before', async () => {
    const s = await approvedSession()
    expect(await ephemeralSecretOf(s.b.db, s.f.session)).not.toBeNull()
    await approve(s)
    expect(await ephemeralSecretOf(s.b.db, s.f.session)).not.toBeNull()
    await sweepSessions(s.b.db, outcome('void'), s.f.now, { restart: false })
    expect(await ephemeralSecretOf(s.b.db, s.f.session)).toBeNull()
  })

  it('pursue_record_never_sets_recorded_from_the_response', async () => {
    const s = await approvedSession()
    await approve(s)
    await adoptFinal(s.b.db, deps(s), s.f.session, s.f.statementBytes, {
      signatures: await s.f.sign(s.statement),
      proof: new Uint8Array(256),
    })
    const ports = {
      submitNetting: async () => ({ signature: 'sig', pending: false }),
      payNettingRecord: async () => 'pay',
      quoteNettingRecord: async () => ({ lamports: 1, sponsor: 's', expiresAt: 0 }),
      recordNettingPaying: async () => ({ signature: 'x' }),
    }
    expect(await pursueRecord(s.b.db, {}, s.f.session, ports)).toEqual({ step: 'submitted' })
    expect((await loadSession(s.b.db, s.f.session))?.status).toBe(Status.Agreed)
  })

  it('capped_free_lane_asks_for_the_paid_lane_then_for_member_paid', async () => {
    const s = await approvedSession()
    await approve(s)
    await adoptFinal(s.b.db, deps(s), s.f.session, s.f.statementBytes, {
      signatures: await s.f.sign(s.statement),
      proof: new Uint8Array(256),
    })
    const quote = { lamports: 1_000_000, sponsor: 'sponsor', expiresAt: s.f.now + 60 }
    const calls: string[] = []
    const ports = {
      submitNetting: async (_s: unknown, _g: unknown, _p: unknown, payment?: string) => {
        calls.push(payment ? 'paid' : 'free')
        return payment ? { signature: 'ok', pending: false } : { capped: true as const }
      },
      quoteNettingRecord: async () => quote,
      payNettingRecord: async () => 'paymentSignature',
      recordNettingPaying: async () => ({ signature: 'v1' }),
    }
    expect(await pursueRecord(s.b.db, {}, s.f.session, ports)).toEqual({ step: 'needs-fee', quote })
    expect(await pursueRecord(s.b.db, { payFee: true }, s.f.session, ports)).toEqual({ step: 'submitted' })
    expect(calls).toEqual(['free', 'free', 'paid'])
    const refusing = { ...ports, submitNetting: async () => ({ capped: true as const }) }
    expect(await pursueRecord(s.b.db, { payFee: true }, s.f.session, refusing)).toEqual({ step: 'member-paid' })
  })

  it('sessions_round_trip_joins_digests_leaves_and_list_newest_first', async () => {
    const s = await approvedSession()
    const row = await loadSession(s.b.db, s.f.session)
    expect(row?.joins).toEqual(s.f.rosterOf(1))
    expect(row?.digests).toEqual(s.f.built.proposal.digests)
    expect(row?.leaves).toEqual(s.f.leavesOf(1))
    await createSession(s.b.db, {
      session: new Uint8Array(32).fill(5),
      role: 0,
      myIndex: 0,
      ephemeralSecret: new Uint8Array(32),
      now: s.f.now + 10,
    })
    expect((await listSessions(s.b.db, 10))[0].session).toEqual(new Uint8Array(32).fill(5))
  })
})
