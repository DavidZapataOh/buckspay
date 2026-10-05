import type { Windows } from '../../protocol'
import { formatAmount } from '../../utils/format-amount'
import { formatSol } from '../../utils/format-sol'
import { isWithdrawable, type LockRecord, withdrawalOpensAt } from './locks'

/** The symbol of the token that funds locks. */
export const FUNDING_SYMBOL = 'USDC'

export const onboardingCopy = {
  walletChangedTransaction:
    'Your wallet changed the transaction, so Buckspay could not cover its network cost. Nothing was sent and nothing was charged. Open Buckspay in Phantom or Solflare, or add about 0.005 SOL to activate with your own wallet.',
}

const amount = (units: bigint, decimals: number) => `${formatAmount(units, decimals)} ${FUNDING_SYMBOL}`

export const minimumNotice = (minimum: bigint, decimals: number) =>
  `The minimum to add is ${amount(minimum, decimals)}.`

/** What a sponsored activation charges besides the funds: the quoted fee, or that there is none. */
export const feeNotice = (fee: bigint, decimals: number) =>
  fee > 0n ? `Buckspay charges a fee of ${amount(fee, decimals)}, on top of your funds.` : 'There is no fee.'

/** Who pays Solana's network costs: Buckspay while it sponsors, otherwise the wallet. */
export const networkCostNotice = (sponsored: boolean, cost: bigint) =>
  sponsored
    ? 'Buckspay pays the network costs. Your wallet pays nothing else.'
    : `Your wallet pays the network costs, about ${formatSol(cost, 'up')} SOL. Not refundable.`

const date = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10)

/** When the wallet can take its funds back from a lock that ends at `lockUntil`. */
export const withdrawalDateNotice = (lockUntil: number, { claimWindow }: Windows) =>
  `You can take your funds back from ${date(lockUntil + claimWindow)} (UTC).`

export const lockSummary = (lock: LockRecord, decimals: number) =>
  `${amount(lock.backingLeft, decimals)} backing left, ${amount(lock.bondFree, decimals)} bond free` +
  (lock.bondSlashed > 0n ? `, ${amount(lock.bondSlashed, decimals)} slashed` : '')

/** What a lock says about taking its funds back, and whether the button shows. */
export function withdrawalStatus(lock: LockRecord, windows: Windows, now: number) {
  if (lock.withdrawn) return { text: 'Withdrawn.', canWithdraw: false }
  if (isWithdrawable(lock, windows, now)) return { text: 'You can take your funds back now.', canWithdraw: true }
  return {
    text: `You can take your funds back from ${date(withdrawalOpensAt(lock, windows))} (UTC).`,
    canWithdraw: false,
  }
}

/** What a pending rotation of this phone's registration says, and what the wallet can do about it. */
export const rotationNotice = (newWallet: string, effectiveAt: number) =>
  `Someone asked to move this phone to wallet ${newWallet}. It takes effect on ${date(effectiveAt)} (UTC). If this wasn’t you, cancel it now.`
