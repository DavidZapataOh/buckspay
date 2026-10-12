export const LANGUAGES = ['en', 'es', 'pt'] as const
export type Language = (typeof LANGUAGES)[number]

/** Each language in its own words, so a person who cannot read the current one can still find theirs. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', es: 'Español', pt: 'Português' }

/** The regional rules for numbers and dates: the pilot is Colombia and Brazil. */
export const NUMBER_LOCALE: Record<Language, string> = { en: 'en-US', es: 'es-CO', pt: 'pt-BR' }

const supported = (tag: string): Language | undefined => {
  const language = tag.split(/[-_]/)[0]?.toLowerCase()
  return LANGUAGES.find((candidate) => candidate === language)
}

/** What the person chose, else the first language the phone lists that the app has, else English. */
export function resolveLanguage(chosen: string | null, deviceTags: readonly string[]): Language {
  const own = chosen === null ? undefined : supported(chosen)
  if (own !== undefined && chosen === own) return own
  for (const tag of deviceTags) {
    const found = supported(tag)
    if (found !== undefined) return found
  }
  return 'en'
}
