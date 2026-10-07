import { describe, expect, it } from 'vitest'
import { missing, privatePath, provingMode, SUBMIT_SPREAD, submitAt } from './policy'

const HOUR = 3600

describe('privatePath', () => {
  it('uses ZK only when there is an intermediary', () => {
    expect(privatePath({ spends: 1 })).toBe(false)
    expect(privatePath({ spends: 2 })).toBe(true)
    expect(privatePath({ spends: 16 })).toBe(true)
  })
})

describe('provingMode', () => {
  const settleBy = 1_000_000
  it('is now when the user asked', () => {
    expect(provingMode({ userAsked: true, now: 0, settleBy })).toBe('now')
  })
  it('is deadline inside the last 24 h before the margin', () => {
    expect(provingMode({ userAsked: false, now: settleBy - 47 * HOUR, settleBy })).toBe('deadline')
    expect(provingMode({ userAsked: false, now: settleBy - 49 * HOUR, settleBy })).toBe('charging')
  })
  it('switches one second inside the 48 hours before the end', () => {
    expect(provingMode({ userAsked: false, now: settleBy - 48 * HOUR, settleBy })).toBe('charging')
    expect(provingMode({ userAsked: false, now: settleBy - 48 * HOUR + 1, settleBy })).toBe('deadline')
  })
  it('never waits for the charger past the deadline', () => {
    expect(provingMode({ userAsked: false, now: settleBy, settleBy })).toBe('deadline')
  })
})

describe('missing', () => {
  it('lists the messages without a proof under the current key', () => {
    const proofs = [
      { index: 0, vkSha256: 'k1' },
      { index: 1, vkSha256: 'k0' },
      { index: 3, vkSha256: 'k1' },
    ]
    expect(missing(5, proofs, 'k1')).toEqual([1, 2, 4])
  })
  it('lists nothing when every message has a proof', () => {
    expect(
      missing(
        2,
        [
          { index: 0, vkSha256: 'k' },
          { index: 1, vkSha256: 'k' },
        ],
        'k',
      ),
    ).toEqual([])
  })
})

describe('submitAt', () => {
  it('submits at once when the user asked', () => {
    expect(submitAt({ noteId: 'a', readyAt: 500, userAsked: true })).toBe(500)
  })
  it('holds a note back by a fixed delay inside the spread, different for different notes', () => {
    const delays = ['a', 'b', 'c', 'd', 'e', 'f'].map((noteId) => submitAt({ noteId, readyAt: 0, userAsked: false }))
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(0)
      expect(delay).toBeLessThan(SUBMIT_SPREAD)
    }
    expect(new Set(delays).size).toBeGreaterThan(1)
    expect(submitAt({ noteId: 'a', readyAt: 0, userAsked: false })).toBe(delays[0])
  })
})
