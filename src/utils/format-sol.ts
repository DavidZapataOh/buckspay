import { currentLanguage } from '../i18n'
import { NUMBER_LOCALE } from '../i18n/languages'

/** Lamports in SOL to four decimals, rounded down, or up for what something costs, in the decimal mark of the language. */
export function formatSol(lamports: bigint, round: 'down' | 'up' = 'down'): string {
  const tenThousandths = Number(lamports) / 100_000
  const sol = (round === 'up' ? Math.ceil(tenThousandths) : Math.floor(tenThousandths)) / 10_000
  return new Intl.NumberFormat(NUMBER_LOCALE[currentLanguage()], { maximumFractionDigits: 4 }).format(sol)
}
