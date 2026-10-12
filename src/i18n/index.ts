import { createInstance } from 'i18next'
import { getLocales } from 'expo-localization'
import { initReactI18next } from 'react-i18next'
import './polyfills'
import { LANGUAGES, type Language, resolveLanguage } from './languages'
import { loadLanguagePreference, saveLanguagePreference } from './preference'
import { resources } from './resources'

export { NAMESPACES } from './resources'

export const i18n = createInstance()

void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: [...LANGUAGES],
  resources,
  defaultNS: 'common',
  ns: Object.keys(resources.en),
  initAsync: false,
  interpolation: { escapeValue: false },
  // A text rendered without the value one of its placeholders needs is a mistake in the code: it must not reach a screen.
  missingInterpolationHandler: (_text, match) => {
    if (process.env.NODE_ENV !== 'production') throw new Error(`No value for ${match[1]}`)
    return ''
  },
})

const deviceTags = () => getLocales().map((locale) => locale.languageTag)

/** The language the phone itself asks for, among those the app has. */
export const deviceLanguage = (): Language => resolveLanguage(null, deviceTags())

export const currentLanguage = (): Language => resolveLanguage(i18n.language, [])

/** Activates the language the person chose, or else the one the phone uses. */
export async function initLanguage(): Promise<Language> {
  const language = resolveLanguage(await loadLanguagePreference(), deviceTags())
  if (language !== i18n.language) await i18n.changeLanguage(language)
  return language
}

/** Keeps a choice and activates it; `null` forgets it and follows the phone. */
export async function setLanguage(choice: Language | null): Promise<Language> {
  await saveLanguagePreference(choice).catch(() => {})
  const language = resolveLanguage(choice, choice === null ? deviceTags() : [])
  await i18n.changeLanguage(language)
  return language
}

/** The text under a key chosen at run time, or undefined when this language has none for it. */
export function translateIfKnown(key: string, options?: Record<string, unknown>): string | undefined {
  return i18n.exists(key) ? String(i18n.t(key as never, options as never)) : undefined
}
