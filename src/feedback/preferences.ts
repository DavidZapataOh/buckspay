import AsyncStorage from '@react-native-async-storage/async-storage'

const STORE = 'feedback:v1'

export type FeedbackPrefs = { sound: boolean; haptics: boolean }

/** Every answer is felt and heard until the person turns it off. */
export const DEFAULT_PREFS: FeedbackPrefs = { sound: true, haptics: true }

export async function loadFeedbackPreferences(): Promise<FeedbackPrefs> {
  try {
    const stored: unknown = JSON.parse((await AsyncStorage.getItem(STORE)) ?? 'null')
    if (typeof stored !== 'object' || stored === null) return DEFAULT_PREFS
    const { sound, haptics } = stored as Record<string, unknown>
    return typeof sound === 'boolean' && typeof haptics === 'boolean' ? { sound, haptics } : DEFAULT_PREFS
  } catch {
    return DEFAULT_PREFS
  }
}

export async function saveFeedbackPreferences(prefs: FeedbackPrefs): Promise<void> {
  await AsyncStorage.setItem(STORE, JSON.stringify(prefs))
}
