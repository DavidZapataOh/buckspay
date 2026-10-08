import { TransportError } from '../../transport/types'
import { debtsCopy } from './copy'
import { DeclineReason, TabDeclined } from './exchange'
import { TabRefusal } from './tab'

/** The sentence a person reads when an exchange ends without a signed state. */
export function failureText(error: unknown, peer: string): string {
  if (error instanceof TabDeclined) {
    switch (error.reason) {
      case DeclineReason.Declined:
        return debtsCopy.declined(peer)
      case DeclineReason.Locked:
        return debtsCopy.refused.locked
      case DeclineReason.Stale:
      case DeclineReason.Behind:
        return debtsCopy.synced
      case DeclineReason.OtherTab:
        return debtsCopy.refused.other
      default:
        return debtsCopy.refused.invalid
    }
  }
  if (error instanceof TabRefusal) {
    switch (error.reason) {
      case 'locked':
      case 'pending':
        return debtsCopy.refused.locked
      case 'stale':
        return debtsCopy.refused.stale
      case 'other-tab':
        return debtsCopy.refused.other
      case 'amount':
        return debtsCopy.errors.amount
      case 'memo':
        return debtsCopy.errors.memo
      default:
        return debtsCopy.refused.invalid
    }
  }
  return error instanceof TransportError ? error.message : error instanceof Error ? error.message : String(error)
}
