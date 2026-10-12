import { i18n } from './index'
import { type Language, NUMBER_LOCALE } from './languages'

/** Base units of a token as a decimal string without trailing zeros, always with a point. */
export function formatAmount(units: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals)
  const fraction = (units % scale).toString().padStart(decimals, '0').replace(/0+$/, '')
  return fraction ? `${units / scale}.${fraction}` : String(units / scale)
}

const marks = new Map<Language, { group: string; decimal: string }>()

function separators(language: Language) {
  let found = marks.get(language)
  if (!found) {
    const parts = new Intl.NumberFormat(NUMBER_LOCALE[language]).formatToParts(1234.5)
    found = {
      group: parts.find((part) => part.type === 'group')?.value ?? ',',
      decimal: parts.find((part) => part.type === 'decimal')?.value ?? '.',
    }
    marks.set(language, found)
  }
  return found
}

/** Money as a person reads it: at least two decimals ("5,00"), more only when the amount needs them, thousands grouped. */
export function formatMoney(units: bigint, decimals: number, language: Language): string {
  const [whole, fraction = ''] = formatAmount(units, decimals).split('.')
  const { group, decimal } = separators(language)
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group)
  const places = Math.min(2, decimals)
  return places === 0 ? grouped : `${grouped}${decimal}${fraction.padEnd(places, '0')}`
}

/**
 * The base units of a decimal amount a person typed, with a point or a comma, or `undefined` if it is not one the token can hold.
 * A single separator followed by exactly three digits after one to three whole digits ("1.000") is refused: it is a thousand in
 * one language and one unit in another.
 */
export function parseAmount(text: string, decimals: number): bigint | undefined {
  const match = /^(\d+)(?:[.,](\d+))?$/.exec(text.trim())
  if (!match) return undefined
  const [, whole, fraction = ''] = match
  if (fraction.length > decimals) return undefined
  if (fraction.length === 3 && /^[1-9]\d{0,2}$/.test(whole)) return undefined
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || 0)
}

const dateTime = (language: Language, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(NUMBER_LOCALE[language], options)

export function formatDateTime(epochSeconds: number, language: Language, timeZone?: string): string {
  return dateTime(language, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(epochSeconds * 1000))
}

export function formatDate(epochSeconds: number, language: Language, timeZone?: string): string {
  return dateTime(language, { dateStyle: 'medium', timeZone }).format(new Date(epochSeconds * 1000))
}

/** Time left as `m:ss`. */
export function formatCountdown(seconds: number): string {
  const left = Math.max(0, seconds)
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

/** A length of time in words, in the active language: "1 hour 30 minutes", "10 minutos". */
export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const hour = (count: number) => i18n.t('common:duration.hour', { count })
  const minute = (count: number) => i18n.t('common:duration.minute', { count })
  if (hours > 0) return minutes > 0 ? `${hour(hours)} ${minute(minutes)}` : hour(hours)
  return minutes > 0 ? minute(minutes) : i18n.t('common:duration.second', { count: seconds })
}
