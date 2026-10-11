import type { PayLimits } from '../../payment/preflight'

const e2e = process.env.EXPO_PUBLIC_E2E === '1'

/** End-to-end builds only: lowers a fingerprint threshold (minor units) so the prompt can be tested with small amounts. */
const lowered = (value: string | undefined, standard: bigint) => (e2e && value ? BigInt(value) : standard)

/** What the payer and the receiver hold to, in one place: the screens read these same numbers. */
export const PAY_LIMITS: PayLimits = {
  noteLifetime: 72 * 3600,
  noteHops: 3,
  requestTtl: 600,
  skewTolerance: 120,
  transferMargin: 120,
  maxPayment: 100_000_000n,
  biometricFrom: lowered(process.env.EXPO_PUBLIC_E2E_BIOMETRIC_FROM, 20_000_000n),
  biometricDaily: lowered(process.env.EXPO_PUBLIC_E2E_BIOMETRIC_DAILY, 50_000_000n),
}

/** How long a note a receiver accepts must stay valid, seconds; the request carries it. */
export const MIN_WINDOW = 3600
