import type { Windows } from '../../protocol'
import { i18n } from '../../i18n'
import type { ClaimOutcome } from './settle'

/**
 * Shown once, before the first clear-text settlement: what the chain publishes. The private path,
 * when it exists, is preferred.
 */
export const settlementLabel = () => i18n.t('settlement:settlementLabel')

/** Shown once, before the first reclaim: it publishes the chain even where settling would not. */
export const reclaimLabel = () => i18n.t('settlement:reclaimLabel')

/** Shown with both: who else sees the chain. */
export const gatewayLabel = () => i18n.t('settlement:gatewayLabel')

/** What a wallet that pays for itself adds: its address is kept in the records it pays for. */
export const selfPayLabel = () => i18n.t('settlement:selfPayLabel')

const date = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10)

/** The payee's obligation: after this date the spender may take the payment back, and the bond does not cover it. */
export const payeeObligation = (expiry: number, { grace }: Windows) =>
  i18n.t('settlement:payeeObligation', { date: date(expiry + grace) })

const duration = (seconds: number) =>
  seconds < 86_400
    ? i18n.t('settlement:duration.minutes', { count: Math.round(seconds / 60) })
    : i18n.t('settlement:duration.days', { count: Math.floor(seconds / 86_400) })

/** How long the owner can reclaim an unsettled output: until the retention ends, or the lock does if sooner. */
export const reclaimWindowNotice = ({ claimWindow, challenge }: Windows) =>
  i18n.t('settlement:reclaimWindow', { duration: duration(claimWindow + challenge) })

/** What filing the loss did: the bond burns, nobody is repaid, and the words promise nothing else. */
export function claimNotice(outcome: ClaimOutcome): string {
  switch (outcome.kind) {
    case 'reported':
      if (outcome.state === 'late') return i18n.t('settlement:claim.late')
      if (outcome.state === 'already') return i18n.t('settlement:claim.already')
      return i18n.t('settlement:claim.reported')
    case 'nothing_to_burn':
      if (outcome.reason === 'no_bond') return i18n.t('settlement:claim.noBond')
      if (outcome.reason === 'lock_ended') return i18n.t('settlement:claim.lockEnded')
      return i18n.t('settlement:claim.cannotFile')
    case 'unavailable':
      return i18n.t('settlement:claim.unavailable')
  }
}

/** What a refusal asks of the user. */
export function refusalNotice(kind: string, retryAt?: number): string {
  switch (kind) {
    case 'conflict':
      return i18n.t('settlement:refusal.conflict')
    case 'no_token_account':
      return i18n.t('settlement:refusal.noTokenAccount')
    case 'window':
      return i18n.t('settlement:refusal.window')
    case 'closed':
      return i18n.t('settlement:refusal.closed')
    case 'deadline':
      return i18n.t('settlement:refusal.deadline')
    case 'lock_ended':
      return i18n.t('settlement:refusal.lockEnded')
    case 'horizon':
      return retryAt === undefined
        ? i18n.t('settlement:refusal.horizonUnknown')
        : i18n.t('settlement:refusal.horizon', { date: date(retryAt) })
    case 'below_minimum':
      return i18n.t('settlement:refusal.belowMinimum')
    default:
      return i18n.t('settlement:refusal.default')
  }
}

/** The balance shown is the sum over every token account of the wallet for the mint: a payment may have been settled into any of them. */
export const balanceNotice = () => i18n.t('settlement:balance')
