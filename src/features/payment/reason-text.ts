import type { Reason } from '../../payment/reasons'
import { formatDuration } from '../../utils/format-duration'
import { formatMoney } from '../../utils/format-amount'
import { copy, text } from './copy'

/** The sentence for a refusal, with this phone's own limits filled in. Nothing about the payer's bond is a number here. */
export function reasonText(
  reason: Reason,
  { window, max, symbol, decimals }: { window: number; max: bigint; symbol: string; decimals: number },
): string {
  if (!(reason in copy.reason)) return ''
  return text(copy.reason[reason as keyof typeof copy.reason], {
    window: formatDuration(window),
    max: `${formatMoney(max, decimals)} ${symbol}`,
  })
}
