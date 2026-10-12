import { describe, expect, it } from 'vitest'
import { LANGUAGE_NAMES, LANGUAGES, NUMBER_LOCALE, resolveLanguage } from './languages'

describe('the languages of the app', () => {
  it('are English, Spanish and Portuguese, each named in its own language', () => {
    expect(LANGUAGES).toEqual(['en', 'es', 'pt'])
    expect(LANGUAGE_NAMES).toEqual({ en: 'English', es: 'Español', pt: 'Português' })
    expect(NUMBER_LOCALE).toEqual({ en: 'en-US', es: 'es-CO', pt: 'pt-BR' })
  })
})

describe('resolveLanguage', () => {
  it('uses what the person chose, whatever the phone says', () => {
    expect(resolveLanguage('pt', ['es-CO'])).toBe('pt')
  })

  it('follows the phone when nothing was chosen, with the first language it lists that the app has', () => {
    expect(resolveLanguage(null, ['es-CO', 'en-US'])).toBe('es')
    expect(resolveLanguage(null, ['es-419'])).toBe('es')
    expect(resolveLanguage(null, ['pt-BR'])).toBe('pt')
    expect(resolveLanguage(null, ['en-GB'])).toBe('en')
  })

  it('skips a language the app does not have and takes the next one the phone lists', () => {
    expect(resolveLanguage(null, ['fr-FR', 'pt-BR'])).toBe('pt')
  })

  it('falls back to English when the phone lists nothing the app has', () => {
    expect(resolveLanguage(null, ['fr-FR', 'de-DE'])).toBe('en')
    expect(resolveLanguage(null, [])).toBe('en')
  })

  it('ignores a chosen language the app does not have', () => {
    expect(resolveLanguage('xx', ['es-419'])).toBe('es')
  })

  it('reads a tag in any case', () => {
    expect(resolveLanguage(null, ['PT-br'])).toBe('pt')
  })
})
