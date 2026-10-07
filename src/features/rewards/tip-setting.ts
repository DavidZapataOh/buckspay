import AsyncStorage from '@react-native-async-storage/async-storage'

const STORE = 'tip-setting:v1'

/** Tipping starts on: the person turns it off in Settings. */
export const DEFAULT_TIPPING = true

/** What is stored when it cannot be read is the default, so a damaged value never turns tipping off or on by surprise. */
export async function loadTipping(): Promise<boolean> {
  const stored = await AsyncStorage.getItem(STORE)
  return stored === 'on' ? true : stored === 'off' ? false : DEFAULT_TIPPING
}

export async function saveTipping(on: boolean): Promise<void> {
  await AsyncStorage.setItem(STORE, on ? 'on' : 'off')
}
