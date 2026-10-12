import { beforeEach, describe, expect, it, vi } from 'vitest'
import AsyncStorage, { resetAsyncStorage, storedItems } from '../test-support/async-storage'
import { loadLanguagePreference, saveLanguagePreference } from './preference'

vi.mock('@react-native-async-storage/async-storage', () => import('../test-support/async-storage'))

beforeEach(resetAsyncStorage)

describe('the language the person chose', () => {
  it('is nothing at first', async () => {
    expect(await loadLanguagePreference()).toBeNull()
  })

  it('is kept and given back', async () => {
    await saveLanguagePreference('es')
    expect(await loadLanguagePreference()).toBe('es')
  })

  it('is forgotten when the person goes back to the language of the phone', async () => {
    await saveLanguagePreference('pt')
    await saveLanguagePreference(null)
    expect(await loadLanguagePreference()).toBeNull()
    expect(storedItems()).toEqual({})
  })

  it('is ignored when what is stored cannot be read or names a language the app does not have', async () => {
    await AsyncStorage.setItem('language:v1', 'not json')
    expect(await loadLanguagePreference()).toBeNull()
    await AsyncStorage.setItem('language:v1', '"klingon"')
    expect(await loadLanguagePreference()).toBeNull()
    await AsyncStorage.setItem('language:v1', '42')
    expect(await loadLanguagePreference()).toBeNull()
  })
})
