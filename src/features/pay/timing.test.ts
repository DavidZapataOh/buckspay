import { afterEach, describe, expect, it, vi } from 'vitest'
import { mark, pause, report, trace } from './timing'

afterEach(() => vi.unstubAllEnvs())

describe('timing marks', () => {
  it('do nothing in a build that is not an end-to-end build', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    mark('tap')
    report()
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('log one PAYTIME line of durations between marks, and nothing else, in an end-to-end build', () => {
    vi.stubEnv('EXPO_PUBLIC_E2E', '1')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const now = vi.spyOn(performance, 'now')
    now.mockReturnValueOnce(1000).mockReturnValueOnce(1040).mockReturnValueOnce(1100)
    mark('tap')
    mark('prepared')
    mark('signed')
    report()
    expect(log).toHaveBeenCalledTimes(1)
    const [line] = log.mock.calls[0]
    expect(line).toMatch(/^PAYTIME /)
    expect(JSON.parse(String(line).slice('PAYTIME '.length))).toEqual({ prepared: 40, signed: 100 })
    log.mockRestore()
    now.mockRestore()
  })

  it('does not hold a payment in a build that is not an end-to-end build, whatever the pause says', async () => {
    vi.stubEnv('EXPO_PUBLIC_E2E_PAUSE', '5000')
    vi.useFakeTimers()
    let resumed = false
    void pause().then(() => (resumed = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(resumed).toBe(true)
    vi.useRealTimers()
  })

  it('holds a payment for the pause in an end-to-end build, and not for a missing or invalid one', async () => {
    vi.stubEnv('EXPO_PUBLIC_E2E', '1')
    vi.useFakeTimers()
    vi.stubEnv('EXPO_PUBLIC_E2E_PAUSE', '5000')
    let resumed = false
    void pause().then(() => (resumed = true))
    await vi.advanceTimersByTimeAsync(4999)
    expect(resumed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(resumed).toBe(true)
    for (const value of ['', 'soon', '-5']) {
      vi.stubEnv('EXPO_PUBLIC_E2E_PAUSE', value)
      let immediate = false
      void pause().then(() => (immediate = true))
      await vi.advanceTimersByTimeAsync(0)
      expect(immediate).toBe(true)
    }
    vi.useRealTimers()
  })

  it('writes nothing for a trace in a build that is not an end-to-end build', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    trace('respend', { held: 1 })
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('writes one PAYTRACE line with the name and what was looked at, in an end-to-end build', () => {
    vi.stubEnv('EXPO_PUBLIC_E2E', '1')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    trace('respend', { held: 2, result: 'NoPassableNote' })
    expect(log).toHaveBeenCalledTimes(1)
    const [line] = log.mock.calls[0]
    expect(line).toMatch(/^PAYTRACE /)
    expect(JSON.parse(String(line).slice('PAYTRACE '.length))).toEqual({
      name: 'respend',
      held: 2,
      result: 'NoPassableNote',
    })
    log.mockRestore()
  })
})
