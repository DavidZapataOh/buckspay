import type { PayError } from '../../payment/pay'
import type { resources } from '../../i18n/resources'

type PayErrorKey = keyof (typeof resources)['en']['payment']['payError']

/** The sentence a payer's failure is shown as. */
export function payErrorKey(error: PayError, code?: string): PayErrorKey {
  if (error.code === 'Declined' && error.cause === 'NoScreenLock') return 'NoScreenLock'
  if (error.code !== 'SignFailed') return error.code
  if (code === 'ERR_DEVICE_LOCKED') return 'Locked'
  if (code === 'ERR_KEY_UNAVAILABLE' || code === 'ERR_NOTE_GUARD_UNAVAILABLE') return 'NoKey'
  return 'SignFailed'
}
