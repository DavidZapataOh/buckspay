import { en, es, pt } from 'make-plural/cardinals'
import { en as enCategories, es as esCategories, pt as ptCategories } from 'make-plural/pluralCategories'

type Category = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

const RULES: Record<string, { select: (n: number) => Category; categories: readonly Category[] }> = {
  en: { select: en, categories: enCategories.cardinal },
  es: { select: es, categories: esCategories.cardinal },
  pt: { select: pt, categories: ptCategories.cardinal },
}

/**
 * Intl.PluralRules for the three languages of the app, from the CLDR rules. Hermes has none, and the general
 * polyfill costs 160 ms of start on the slowest phone we test on.
 */
export class PluralRules {
  readonly #language: string
  readonly #rule: (typeof RULES)[string]

  constructor(locales?: string | readonly string[], options?: { type?: 'cardinal' | 'ordinal' }) {
    if (options?.type === 'ordinal') throw new RangeError('Ordinal plural rules are not available')
    const tag = (Array.isArray(locales) ? locales[0] : locales) ?? 'en'
    const language = String(tag).split('-')[0].toLowerCase()
    const rule = RULES[language]
    if (!rule) throw new RangeError(`No plural rules for ${tag}`)
    this.#language = language
    this.#rule = rule
  }

  select(n: number): Category {
    return this.#rule.select(n)
  }

  resolvedOptions() {
    return { locale: this.#language, type: 'cardinal' as const, pluralCategories: [...this.#rule.categories] }
  }

  static supportedLocalesOf(locales: string | readonly string[]) {
    return [locales].flat().filter((tag) => RULES[String(tag).split('-')[0].toLowerCase()])
  }
}

/** Puts the rules where the engine has none of its own. */
export function installPluralRules(target: { PluralRules?: unknown } = Intl) {
  if (typeof target.PluralRules !== 'function') {
    Object.defineProperty(target, 'PluralRules', { value: PluralRules, configurable: true, writable: true })
  }
}
