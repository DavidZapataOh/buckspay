import type { Windows } from '../../protocol'
import type { ClaimOutcome } from './settle'

/**
 * Shown once, before the first clear-text settlement: what the chain publishes. The private path,
 * when it exists, is preferred.
 */
export const settlementLabel =
  'Settling this payment publishes the keys of the people it passed through, every amount, and the account that is paid.'

/** Shown once, before the first reclaim: it publishes the chain even where settling would not. */
export const reclaimLabel =
  'Taking this payment back publishes the whole chain it passed through, your key and the amounts, even if the payment would otherwise have settled privately.'

/** Shown with both: who else sees the chain. */
export const gatewayLabel =
  "Buckspay's server sees this chain, your network address and the time. The private path (when it exists) does not show it the keys."

/** What a wallet that pays for itself adds: its address is kept in the records it pays for. */
export const selfPayLabel = 'Your wallet address is stored in the records it pays for, until they are closed.'

const date = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10)

/** The payee's obligation: after this date the spender may take the payment back, and the bond does not cover it. */
export const payeeObligation = (expiry: number, { grace }: Windows) =>
  `Settle this payment before ${date(expiry + grace)} (UTC). After that the person who paid you may take it back, and the loss is not covered by their bond.`

const duration = (seconds: number) => {
  if (seconds < 86_400) return `${Math.round(seconds / 60)} minutes`
  const days = Math.floor(seconds / 86_400)
  return days === 1 ? '1 day' : `${days} days`
}

/** How long the owner can reclaim an unsettled output: until the retention ends, or the lock does if sooner. */
export const reclaimWindowNotice = ({ claimWindow, challenge }: Windows) =>
  `You can take an unsettled payment back for ${duration(claimWindow + challenge)} after its settlement window, or until its lock ends if that is sooner. An output of a key with no registered device cannot be taken back at all.`

const notRepaid = 'You were not repaid: the bond is not paid out.'

/** What filing the loss did: the bond burns, nobody is repaid, and the words promise nothing else. */
export function claimNotice(outcome: ClaimOutcome): string {
  switch (outcome.kind) {
    case 'reported':
      if (outcome.state === 'late') return `This loss was reported too late: nothing was burned. ${notRepaid}`
      if (outcome.state === 'already')
        return `The payer signed this money twice and their bond was already destroyed. ${notRepaid}`
      return `The payer signed this money twice. Their bond is destroyed. ${notRepaid}`
    case 'nothing_to_burn':
      if (outcome.reason === 'no_bond') return `The payer's lock has nothing left to burn. ${notRepaid}`
      if (outcome.reason === 'lock_ended')
        return `The payer's lock has ended, so the loss can no longer be filed. ${notRepaid}`
      return `This loss cannot be filed against the payer's lock. ${notRepaid}`
    case 'unavailable':
      return 'Buckspay could not file the loss now. Keep this payment and try again later.'
  }
}

/** What a refusal asks of the user. */
export function refusalNotice(kind: string, retryAt?: number): string {
  switch (kind) {
    case 'conflict':
      return 'The payer signed this money twice: another payment of it was settled first. You were not repaid: the bond is not paid out. Keep this payment.'
    case 'no_token_account':
      return 'The account that is paid has no token account for this money yet. Create it in the wallet, then settle again.'
    case 'window':
      return 'The time to settle this payment has run out.'
    case 'closed':
      return 'The time to take this payment back has run out.'
    case 'deadline':
      return 'The signature to take this payment back is out of date. Sign it again.'
    case 'lock_ended':
      return 'The issuer’s lock has ended.'
    case 'horizon':
      return retryAt === undefined
        ? 'Buckspay cannot pay for this yet.'
        : `Buckspay cannot pay for this before ${date(retryAt)} (UTC). You can pay for it yourself now.`
    case 'below_minimum':
      return 'This amount is too small for Buckspay to pay for. You can pay for it yourself.'
    default:
      return 'Buckspay cannot pay for this now. You can pay for it yourself.'
  }
}

/** The balance shown is the sum over every token account of the wallet for the mint: a payment may have been settled into any of them. */
export const balanceNotice = 'The balance adds up every account of this wallet that holds this money.'
