import { describe, expect, it } from 'vitest'
import { ATTESTER, NOW } from '../../payment/testing/world'
import { REMOTE_MIN_WINDOW, remoteRequest } from './plan'
import { link, planWithBond } from './testing'

describe('remote request', () => {
  it('pays the friend’s account, with the remote window and one hop', () => {
    const r = remoteRequest(link, 3_000_000n, 'rent', { now: NOW, attesters: [ATTESTER.id] })
    expect(r.owner).toEqual({ type: 'account', address: link.wallet })
    expect(r.minWindow).toBe(REMOTE_MIN_WINDOW)
    expect(r.minHops).toBe(1)
    expect(r.amount).toBe(3_000_000n)
  })
  it('the executed planner still applies the bond rule to a remote payment', () => {
    const r = remoteRequest(link, 10_000_000n, '', { now: NOW, attesters: [ATTESTER.id] })
    expect(() => planWithBond(r, { bond: 39_999_999n })).toThrow(/bond/i)
    expect(() => planWithBond(r, { bond: 40_000_000n })).not.toThrow()
  })
  it('the planned note lives at least the remote window past the request', () => {
    const r = remoteRequest(link, 1_000_000n, '', { now: NOW, attesters: [ATTESTER.id] })
    expect(planWithBond(r, { bond: 40_000_000n }).review.expiry).toBeGreaterThanOrEqual(NOW + REMOTE_MIN_WINDOW)
  })
})
