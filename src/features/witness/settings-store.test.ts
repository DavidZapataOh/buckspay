import { beforeEach, describe, expect, it, vi } from 'vitest'
import AsyncStorage, { resetAsyncStorage } from '../../test-support/async-storage'
import { DEFAULT_WITNESS_SETTINGS, loadWitnessSettings, saveWitnessSettings } from './settings-store'

vi.mock('@react-native-async-storage/async-storage', () => import('../../test-support/async-storage'))

beforeEach(resetAsyncStorage)

describe('witness settings', () => {
  it('start with everything off and the microphone untouched', async () => {
    expect(await loadWitnessSettings()).toEqual(DEFAULT_WITNESS_SETTINGS)
    expect(DEFAULT_WITNESS_SETTINGS).toEqual({ ask: false, requireFrom: null, answer: false, audible: false })
  })
  it('round-trip, including the amount to wait from', async () => {
    const settings = { ask: true, requireFrom: 50_000_000n, answer: true, audible: true }
    await saveWitnessSettings(settings)
    expect(await loadWitnessSettings()).toEqual(settings)
  })
  it('fall back to the defaults when what is stored cannot be read', async () => {
    await AsyncStorage.setItem('witness-settings:v1', '{"ask":"yes","requireFrom":"x"}')
    expect(await loadWitnessSettings()).toEqual(DEFAULT_WITNESS_SETTINGS)
    await AsyncStorage.setItem('witness-settings:v1', '{"ask":true,"answer":true,"requireFrom":null}')
    expect(await loadWitnessSettings()).toEqual(DEFAULT_WITNESS_SETTINGS)
    await AsyncStorage.setItem('witness-settings:v1', 'not json')
    expect(await loadWitnessSettings()).toEqual(DEFAULT_WITNESS_SETTINGS)
  })
})
