import type { PayLimits } from '../../payment/preflight'

/** What the payer and the receiver hold to, in one place: the screens read these same numbers. */
export const PAY_LIMITS: PayLimits = {
  noteLifetime: 72 * 3600,
  noteHops: 3,
  requestTtl: 600,
  skewTolerance: 120,
  transferMargin: 120,
  maxPayment: 100_000_000n,
  biometricFrom: 20_000_000n,
  biometricDaily: 50_000_000n,
}

/** How long a note a receiver accepts must stay valid, seconds; the request carries it. */
export const MIN_WINDOW = 3600
