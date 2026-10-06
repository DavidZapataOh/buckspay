import { act } from 'react'
import { create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSecondsLeft } from './use-seconds-left'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let seen: number[]
function Probe({ until, now }: { until?: number; now: () => number }) {
  seen.push(useSecondsLeft(until, now))
  return null
}

beforeEach(() => {
  vi.useFakeTimers()
  seen = []
})
afterEach(() => vi.useRealTimers())

describe('useSecondsLeft', () => {
  it('counts down each second to zero and stops there', async () => {
    let clock = 1_000
    const renderer = await act(async () => create(<Probe until={1_003} now={() => clock} />))
    expect(seen.at(-1)).toBe(3)
    for (let second = 0; second < 5; second++) {
      clock += 1
      await act(async () => vi.advanceTimersByTime(1000))
    }
    expect(seen.at(-1)).toBe(0)
    await act(async () => renderer.unmount())
  })

  it('is zero with nothing to count to', async () => {
    await act(async () => create(<Probe now={() => 1_000} />))
    expect(seen.at(-1)).toBe(0)
  })
})
