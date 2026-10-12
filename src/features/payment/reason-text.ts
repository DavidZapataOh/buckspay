import { formatDuration, formatMoney } from '../../i18n/format'
import { currentLanguage, translateIfKnown } from '../../i18n'
import type { Reason } from '../../payment/reasons'

/** The sentence for a refusal, with this phone's own limits filled in. Nothing about the payer's bond is a number here. */
export function reasonText(
  reason: Reason,
  { window, max, symbol, decimals }: { window: number; max: bigint; symbol: string; decimals: number },
): string {
  return (
    translateIfKnown(`payment:reason.${reason}`, {
      window: formatDuration(window),
      max: `${formatMoney(max, decimals, currentLanguage())} ${symbol}`,
    }) ?? ''
  )
}
