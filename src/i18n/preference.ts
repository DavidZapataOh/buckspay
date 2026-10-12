import AsyncStorage from '@react-native-async-storage/async-storage'
import { LANGUAGES, type Language } from './languages'

const STORE = 'language:v1'

/** The language the person picked in Settings, or null when they follow the phone. */
export async function loadLanguagePreference(): Promise<Language | null> {
  try {
    const stored: unknown = JSON.parse((await AsyncStorage.getItem(STORE)) ?? 'null')
    return LANGUAGES.find((language) => language === stored) ?? null
  } catch {
    return null
  }
}

export async function saveLanguagePreference(language: Language | null): Promise<void> {
  if (language === null) await AsyncStorage.removeItem(STORE)
  else await AsyncStorage.setItem(STORE, JSON.stringify(language))
}
