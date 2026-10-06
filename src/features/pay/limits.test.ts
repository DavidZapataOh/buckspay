import { describe, expect, it } from 'vitest'
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

  it('never ask for a note longer than receivers accept, or a window longer than the note', () => {
    expect(PAY_LIMITS.noteLifetime).toBeLessThanOrEqual(MAX_NOTE_LIFE)
    expect(MIN_WINDOW + PAY_LIMITS.requestTtl + PAY_LIMITS.transferMargin).toBeLessThan(PAY_LIMITS.noteLifetime)
  })
})
