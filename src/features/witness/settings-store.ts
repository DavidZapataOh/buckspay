import AsyncStorage from '@react-native-async-storage/async-storage'
import type { WitnessSettings } from './policy'

const STORE = 'witness-settings:v1'

/** Nothing is asked and nothing is heard until the person turns it on. */
export const DEFAULT_WITNESS_SETTINGS: WitnessSettings = {
  ask: false,
  requireFrom: null,
  answer: false,
  audible: false,
}

export async function loadWitnessSettings(): Promise<WitnessSettings> {
  try {
    const stored: unknown = JSON.parse((await AsyncStorage.getItem(STORE)) ?? 'null')
    if (typeof stored !== 'object' || stored === null) return DEFAULT_WITNESS_SETTINGS
    const { ask, answer, audible, requireFrom } = stored as Record<string, unknown>
    if (
      typeof ask !== 'boolean' ||
      typeof answer !== 'boolean' ||
      typeof audible !== 'boolean' ||
      (requireFrom !== null && typeof requireFrom !== 'string')
    )
      return DEFAULT_WITNESS_SETTINGS
    return { ask, answer, audible, requireFrom: requireFrom === null ? null : BigInt(requireFrom) }
  } catch {
    return DEFAULT_WITNESS_SETTINGS
  }
}

export async function saveWitnessSettings(settings: WitnessSettings): Promise<void> {
  await AsyncStorage.setItem(
    STORE,
    JSON.stringify({
      ...settings,
      requireFrom: settings.requireFrom === null ? null : settings.requireFrom.toString(),
    }),
  )
}
