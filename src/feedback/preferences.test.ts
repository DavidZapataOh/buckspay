import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAsyncStorage } from '../test-support/async-storage'
import { DEFAULT_PREFS, loadFeedbackPreferences, saveFeedbackPreferences } from './preferences'

vi.mock('@react-native-async-storage/async-storage', () => import('../test-support/async-storage'))

beforeEach(resetAsyncStorage)

describe('the sound and vibration the person chose', () => {
  it('start on, so every answer is felt and heard until the person turns it off', async () => {
    expect(DEFAULT_PREFS).toEqual({ sound: true, haptics: true })
    expect(await loadFeedbackPreferences()).toEqual(DEFAULT_PREFS)
  })

  it('are kept between runs', async () => {
    await saveFeedbackPreferences({ sound: false, haptics: true })
    expect(await loadFeedbackPreferences()).toEqual({ sound: false, haptics: true })
  })

  it('fall back to on when what was stored is not something this version wrote', async () => {
    await AsyncStorage.setItem('feedback:v1', JSON.stringify({ sound: 'no' }))
    expect(await loadFeedbackPreferences()).toEqual(DEFAULT_PREFS)
    await AsyncStorage.setItem('feedback:v1', '{broken')
    expect(await loadFeedbackPreferences()).toEqual(DEFAULT_PREFS)
  })
})
