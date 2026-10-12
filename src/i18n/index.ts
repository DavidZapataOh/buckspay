import { createInstance } from 'i18next'
import { getLocales } from 'expo-localization'
import { initReactI18next } from 'react-i18next'
import './polyfills'
import { LANGUAGES, type Language, resolveLanguage } from './languages'
import { loadLanguagePreference, saveLanguagePreference } from './preference'
import { resources } from './resources'

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

export const currentLanguage = (): Language => resolveLanguage(i18n.language, [])

/** Activates the language the person chose, or else the one the phone uses. */
export async function initLanguage(): Promise<Language> {
  const language = resolveLanguage(await loadLanguagePreference(), deviceTags())
  await i18n.changeLanguage(language)
  return language
}

/** Keeps a choice and activates it; `null` forgets it and follows the phone. */
export async function setLanguage(choice: Language | null): Promise<Language> {
  await saveLanguagePreference(choice)
  const language = resolveLanguage(choice, choice === null ? deviceTags() : [])
  await i18n.changeLanguage(language)
  return language
}
