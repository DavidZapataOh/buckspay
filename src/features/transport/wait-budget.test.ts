import { describe, expect, it } from 'vitest'
import { waitBudget } from './wait-budget'

describe('waitBudget', () => {
  it('bounds the wait on Nearby and leaves the other media to their own timers', () => {
    expect(waitBudget('nearby')).toBe(30_000)
    expect(waitBudget('qr')).toBeUndefined()
    expect(waitBudget('nfc')).toBeUndefined()
  })
})
