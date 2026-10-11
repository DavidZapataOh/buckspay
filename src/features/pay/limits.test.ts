import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_NOTE_LIFE } from '../../protocol'
import { MIN_WINDOW, PAY_LIMITS } from './limits'

describe('the limits of the pilot', () => {
  it('are the ones decided: 72 hours, 3 hops, 100 USDC, a fingerprint from 20 and from 50 a day, 10 minutes, 1 hour', () => {
    expect(PAY_LIMITS).toEqual({
      noteLifetime: 72 * 3600,
      noteHops: 3,
      requestTtl: 600,
      skewTolerance: 120,
      transferMargin: 120,
      maxPayment: 100_000_000n,
      biometricFrom: 20_000_000n,
      biometricDaily: 50_000_000n,
    })
    expect(MIN_WINDOW).toBe(3600)
  })

  describe('the thresholds of the fingerprint', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
      vi.resetModules()
    })
    const loaded = async () => {
      vi.resetModules()
      return (await import('./limits')).PAY_LIMITS
    }

    it('can be lowered by an end-to-end build to test the prompt with small amounts', async () => {
      vi.stubEnv('EXPO_PUBLIC_E2E', '1')
      vi.stubEnv('EXPO_PUBLIC_E2E_BIOMETRIC_FROM', '50000')
      vi.stubEnv('EXPO_PUBLIC_E2E_BIOMETRIC_DAILY', '100000')
      expect(await loaded()).toMatchObject({ biometricFrom: 50_000n, biometricDaily: 100_000n })
    })

    it('are never changed in a build that is not an end-to-end one', async () => {
      vi.stubEnv('EXPO_PUBLIC_E2E_BIOMETRIC_FROM', '50000')
      vi.stubEnv('EXPO_PUBLIC_E2E_BIOMETRIC_DAILY', '100000')
      expect(await loaded()).toMatchObject({ biometricFrom: 20_000_000n, biometricDaily: 50_000_000n })
    })
  })

  it('never ask for a note longer than receivers accept, or a window longer than the note', () => {
    expect(PAY_LIMITS.noteLifetime).toBeLessThanOrEqual(MAX_NOTE_LIFE)
    expect(MIN_WINDOW + PAY_LIMITS.requestTtl + PAY_LIMITS.transferMargin).toBeLessThan(PAY_LIMITS.noteLifetime)
  })
})
