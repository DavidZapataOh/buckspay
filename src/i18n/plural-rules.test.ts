import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'
import { installPluralRules, PluralRules } from './plural-rules'

const select = (language: string, n: number) => new PluralRules(language).select(n)

describe('the plural rules of the app', () => {
  it('follow CLDR for English, Spanish and Portuguese', () => {
    expect([0, 1, 2, 5].map((n) => select('en', n))).toEqual(['other', 'one', 'other', 'other'])
    expect([0, 1, 2, 5].map((n) => select('es', n))).toEqual(['other', 'one', 'other', 'other'])
    expect([0, 1, 2, 5].map((n) => select('pt', n))).toEqual(['one', 'one', 'other', 'other'])
    expect(select('es', 1_000_000)).toBe('many')
  })

  it('read a regional tag or a list of tags, and refuse a language they have no rule for', () => {
    expect(new PluralRules('pt-BR').select(0)).toBe('one')
    expect(new PluralRules(['es-CO']).select(1)).toBe('one')
    expect(() => new PluralRules('fr')).toThrow(RangeError)
  })

  it('say which categories a language uses and which language they resolved', () => {
    expect(new PluralRules('es').resolvedOptions()).toMatchObject({
      locale: 'es',
      type: 'cardinal',
      pluralCategories: ['one', 'many', 'other'],
    })
    expect(new PluralRules('en').resolvedOptions().pluralCategories).toEqual(['one', 'other'])
  })

  it('do not pretend to know ordinals, which the app never uses', () => {
    expect(() => new PluralRules('en', { type: 'ordinal' })).toThrow(RangeError)
  })

  it('install themselves only where the engine has no Intl.PluralRules of its own', () => {
    const bare: { PluralRules?: unknown } = {}
    installPluralRules(bare)
    expect(bare.PluralRules).toBe(PluralRules)
    class Own {}
    const has = { PluralRules: Own }
    installPluralRules(has)
    expect(has.PluralRules).toBe(Own)
  })

  it('make i18next choose the right form, as on a phone whose engine has none', async () => {
    const native = Intl.PluralRules
    Object.defineProperty(Intl, 'PluralRules', { value: PluralRules, configurable: true, writable: true })
    try {
      const resources = {
        pt: { translation: { minute_one: '{{count}} minuto', minute_other: '{{count}} minutos' } },
        es: { translation: { minute_one: '{{count}} minuto', minute_other: '{{count}} minutos' } },
      }
      const instance = createInstance()
      await instance.init({ lng: 'pt', resources, initAsync: false })
      expect([0, 1, 2].map((count) => String(instance.t('minute' as never, { count } as never)))).toEqual([
        '0 minuto',
        '1 minuto',
        '2 minutos',
      ])
      await instance.changeLanguage('es')
      expect([0, 1, 2].map((count) => String(instance.t('minute' as never, { count } as never)))).toEqual([
        '0 minutos',
        '1 minuto',
        '2 minutos',
      ])
    } finally {
      Object.defineProperty(Intl, 'PluralRules', { value: native, configurable: true, writable: true })
    }
  })
})
