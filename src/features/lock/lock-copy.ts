import type { Windows } from '../../protocol'
import { i18n } from '../../i18n'
import { formatAmount } from '../../i18n/format'
import { formatSol } from '../../utils/format-sol'
import { isWithdrawable, type LockRecord, withdrawalOpensAt } from './locks'

/** The symbol of the token that funds locks. */
export const FUNDING_SYMBOL = 'USDC'

const amount = (units: bigint, decimals: number) => `${formatAmount(units, decimals)} ${FUNDING_SYMBOL}`

export const minimumNotice = (minimum: bigint, decimals: number) =>
  i18n.t('lock:minimum', { amount: amount(minimum, decimals) })

/** What a sponsored activation charges besides the funds: the quoted fee, or that there is none. */
export const feeNotice = (fee: bigint, decimals: number) =>
  fee > 0n ? i18n.t('lock:fee.charged', { amount: amount(fee, decimals) }) : i18n.t('lock:fee.none')

/** Who pays Solana's network costs: Buckspay while it sponsors, otherwise the wallet. */
export const networkCostNotice = (sponsored: boolean, cost: bigint) =>
  sponsored ? i18n.t('lock:networkCost.sponsored') : i18n.t('lock:networkCost.wallet', { sol: formatSol(cost, 'up') })

const date = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10)

/** When the wallet can take its funds back from a lock that ends at `lockUntil`. */
export const withdrawalDateNotice = (lockUntil: number, { claimWindow }: Windows) =>
  i18n.t('lock:withdrawalDate', { date: date(lockUntil + claimWindow) })

export const lockSummary = (lock: LockRecord, decimals: number) =>
  i18n.t(lock.bondSlashed > 0n ? 'lock:summary.withSlashed' : 'lock:summary.plain', {
    backing: amount(lock.backingLeft, decimals),
    bond: amount(lock.bondFree, decimals),
    slashed: amount(lock.bondSlashed, decimals),
  })

/** What a lock says about taking its funds back, and whether the button shows. */
export function withdrawalStatus(lock: LockRecord, windows: Windows, now: number) {
  if (lock.withdrawn) return { text: i18n.t('lock:withdrawal.withdrawn'), canWithdraw: false }
  if (isWithdrawable(lock, windows, now)) return { text: i18n.t('lock:withdrawal.now'), canWithdraw: true }
  return {
    text: i18n.t('lock:withdrawal.from', { date: date(withdrawalOpensAt(lock, windows)) }),
    canWithdraw: false,
  }
}

/** What a pending rotation of this phone's registration says, and what the wallet can do about it. */
export const rotationNotice = (newWallet: string, effectiveAt: number) =>
  i18n.t('lock:rotation', { wallet: newWallet, date: date(effectiveAt) })
