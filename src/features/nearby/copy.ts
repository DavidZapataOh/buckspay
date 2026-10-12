import { i18n } from '../../i18n'
import type { PairingFailure } from '../../transport/nearby/pairing'

export const failureText = (reason: PairingFailure) => i18n.t(`nearby:failed.${reason}`)

/** The digits as separate words, so a screen reader says "four, eight, two, one". */
export const spokenDigits = (digits: string) => [...digits].join(i18n.t('nearby:digitSeparator'))
