import { i18n } from '../../i18n'
import { TransportError } from '../../transport/types'

import { DeclineReason, TabDeclined } from './exchange'
import { TabRefusal } from './tab'

/** The sentence a person reads when an exchange ends without a signed state. */
export function failureText(error: unknown, peer: string): string {
  if (error instanceof TabDeclined) {
    switch (error.reason) {
      case DeclineReason.Declined:
        return i18n.t('debts:declined', { peer: peer })
      case DeclineReason.Locked:
        return i18n.t('debts:refused.locked')
      case DeclineReason.Stale:
      case DeclineReason.Behind:
        return i18n.t('debts:synced')
      case DeclineReason.OtherTab:
        return i18n.t('debts:refused.other')
      default:
        return i18n.t('debts:refused.invalid')
    }
  }
  if (error instanceof TabRefusal) {
    switch (error.reason) {
      case 'locked':
      case 'pending':
        return i18n.t('debts:refused.locked')
      case 'stale':
        return i18n.t('debts:refused.stale')
      case 'other-tab':
        return i18n.t('debts:refused.other')
      case 'amount':
        return i18n.t('debts:errors.amount')
      case 'memo':
        return i18n.t('debts:errors.memo')
      default:
        return i18n.t('debts:refused.invalid')
    }
  }
  return error instanceof TransportError ? error.message : error instanceof Error ? error.message : String(error)
}
