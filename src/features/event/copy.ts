import { i18n } from '../../i18n'
import { Reason } from '../../payment/reasons'

/** The refusal of a point, or null for a reason that is worded like any receiver's. */
export function pointReasonText(reason: Reason): string | null {
  switch (reason) {
    case Reason.DoubleSpend:
      return i18n.t('event:pointReasons.doubleSpend')
    case Reason.Scope:
      return i18n.t('event:pointReasons.scope')
    case Reason.NotForYou:
      return i18n.t('event:pointReasons.notForYou')
    default:
      return null
  }
}
