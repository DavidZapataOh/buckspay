import { afterEach, describe, expect, it, vi } from 'vitest'
import { mark, report } from './timing'

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
})
