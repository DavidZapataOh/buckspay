import { addEventListener } from 'expo-linking'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installE2eScan } from './e2e-source'

vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })) }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('installE2eScan', () => {
  it('does nothing outside an end-to-end build', () => {
    installE2eScan(vi.fn())()
    expect(addEventListener).not.toHaveBeenCalled()
  })

  it('pushes the text of a buckspay-e2e link in an end-to-end build', () => {
    vi.stubEnv('EXPO_PUBLIC_E2E', '1')
    const push = vi.fn()
    installE2eScan(push)
    const listener = vi.mocked(addEventListener).mock.calls[0][1] as (event: { url: string }) => void
    listener({ url: 'buckspay-e2e://scan?text=BP%3AAB%20C' })
    expect(push).toHaveBeenCalledWith('BP:AB C')
    listener({ url: 'https://example.com/?text=BP%3AAB' })
    listener({ url: 'buckspay://scan?text=BP%3AAB' })
    expect(push).toHaveBeenCalledTimes(1)
  })
})
