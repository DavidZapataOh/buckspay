import { describe, expect, it } from 'vitest'
import { formatDateTime } from '../../i18n/format'
import { sessionView, viewOfOutcome } from './session-view'

const NOW = 1_800_000_000
const base = {
  role: 1 as const,
  expires: NOW + 86_400,
  proof: null,
  nothing: false,
  recordPending: false,
  remainder: [],
}

describe('sessionView', () => {
  it.each([
    [0, 'connecting'],
    [1, 'consent'],
    [2, 'waiting'],
    [3, 'agreed'],
    [4, 'recorded'],
    [5, 'void'],
    [6, 'abandoned'],
    [7, 'undecided'],
  ] as const)('status %i is %s', (status, state) => {
    expect(sessionView({ ...base, status }, NOW).state).toBe(state)
  })

  it('host_status_0_is_the_lobby', () => {
    expect(sessionView({ ...base, role: 0, status: 0 }, NOW).state).toBe('lobby')
  })

  it('recorded_text_appears_only_at_status_4', () => {
    for (const status of [0, 1, 2, 3, 5, 6, 7])
      expect(JSON.stringify(sessionView({ ...base, status }, NOW))).not.toMatch(/Recorded publicly/)
    expect(sessionView({ ...base, status: 4 }, NOW).body).toMatch(/Recorded publicly/)
  })

  it('waiting_and_agreed_name_the_expiry_time_in_the_language_in_use', () => {
    const waiting = sessionView({ ...base, status: 2 }, NOW)
    expect(waiting.body).toContain(formatDateTime(NOW + 86_400, 'en'))
    expect(waiting.body).not.toMatch(/\{\{expires\}\}/)
  })

  it('a_pending_record_shows_recording_until_confirmed_and_never_recorded', () => {
    const pending = sessionView({ ...base, status: 3, recordPending: true }, NOW)
    expect(pending.state).toBe('agreed')
    expect(pending.body).toMatch(/Recording…/)
    expect(JSON.stringify(pending)).not.toMatch(/Recorded publicly/)
    expect(sessionView({ ...base, status: 3, recordPending: false }, NOW).body).not.toMatch(/Recording…/)
  })

  it('nothing_to_net_still_lists_the_remainder', () => {
    const view = sessionView(
      {
        ...base,
        status: 3,
        nothing: true,
        remainder: [{ tab: 'aa', peer: 'x', role: 'debtor', amount: 5_000_000n, status: 0 }],
      },
      NOW,
    )
    expect(view.state).toBe('nothing')
    expect(view.remainder).toHaveLength(1)
  })

  it('proof_flags_are_carried_and_agreed_stays_agreed', () => {
    const view = sessionView({ ...base, status: 3, proof: 'invalid' }, NOW)
    expect(view.state).toBe('agreed')
    expect(view.proof).toBe('invalid')
    expect(view.tone).not.toBe('success')
  })

  it('void_and_abandoned_say_the_debts_stay_as_they_were_and_undecided_says_it_cannot_tell', () => {
    expect(sessionView({ ...base, status: 5 }, NOW).body).toMatch(
      /stay as they were, and any payments you made still count/,
    )
    expect(sessionView({ ...base, status: 7 }, NOW).body).toMatch(/no longer tell/)
    expect(sessionView({ ...base, status: 6 }, NOW).body).toMatch(/Nothing changed/)
  })
})

describe('the states before a session has anything to agree', () => {
  it('a_member_that_is_in_waits_for_the_host_to_begin', () => {
    const view = sessionView({ ...base, status: 0, joined: true }, NOW)
    expect(view.state).toBe('joined')
    expect(view.headline).toBe("You're in")
  })

  it('the_host_that_pressed_start_is_collecting', () => {
    expect(sessionView({ ...base, role: 0, status: 0, collecting: true, count: 2 }, NOW).state).toBe('collecting')
  })
})

describe('viewOfOutcome', () => {
  const when = NOW + 3600
  it.each([
    [{ status: 'nothing' as const }, 'nothing'],
    [{ status: 'abandoned' as const, reason: 1 }, 'abandoned'],
    [{ status: 'refused' as const, refusal: 'NetChanged' as const }, 'abandoned'],
    [{ status: 'pending' as const, expires: when }, 'waiting'],
  ])('%j ends as %s', (outcome, state) => {
    expect(viewOfOutcome(outcome, NOW).state).toBe(state)
  })

  it('an_agreed_netting_keeps_its_proof_and_its_expiry', () => {
    const view = viewOfOutcome(
      {
        status: 'agreed',
        proof: 'missing',
        view: { tabs: [], netBefore: 0n, netAfter: 0n, participants: 2, total: 0n, expires: when },
      },
      NOW,
    )
    expect(view).toMatchObject({ state: 'agreed', proof: 'missing', expiresAt: when })
  })
})
