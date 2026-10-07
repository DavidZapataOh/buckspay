import { describe, expect, it } from 'vitest'
import { rewardRows, totals, type RewardRecord } from './state'

const word = (state: 'held' | 'submitted' | 'in_tree' | 'rejected', extra = {}): RewardRecord => ({
  kind: 'word',
  state,
  value: 500_000n,
  ...extra,
})
const leaf = (state: 'unclaimed' | 'claiming' | 'claimed', exp: number): RewardRecord => ({
  kind: 'leaf',
  state,
  exp,
  unit: 45_000n,
})

describe('reward states', () => {
  it('maps every store state to exactly one screen state', () => {
    expect(rewardRows([word('held')]).map((r) => r.state)).toEqual(['waiting'])
    expect(rewardRows([word('submitted')]).map((r) => r.state)).toEqual(['waiting'])
    expect(rewardRows([leaf('unclaimed', 0)]).map((r) => r.state)).toEqual(['ready'])
    expect(rewardRows([leaf('claiming', 0)]).map((r) => r.state)).toEqual(['claiming'])
    expect(rewardRows([leaf('claimed', 0)]).map((r) => r.state)).toEqual(['claimed'])
    expect(rewardRows([word('rejected', { reason: 'not_delivered' })]).map((r) => r.state)).toEqual(['not_paid'])
  })

  it('shows a word that is in the tree through its leaf only', () => {
    expect(rewardRows([word('in_tree')])).toEqual([])
  })

  it('never counts a word as claimable before its leaf is in the tree', () => {
    const t = totals(rewardRows([word('held'), word('submitted'), leaf('unclaimed', 1)]))
    expect(t.ready).toBe(90_000n)
    expect(t.waiting).toBe(1_000_000n)
    expect(t.claimed).toBe(0n)
  })

  it('does not count a rejected word anywhere', () => {
    const t = totals(rewardRows([word('rejected')]))
    expect([t.waiting, t.ready, t.claiming, t.claimed]).toEqual([0n, 0n, 0n, 0n])
  })
})
