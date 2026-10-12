import { beforeEach, describe, expect, it, vi } from 'vitest'
import AsyncStorage, { resetAsyncStorage } from '../test-support/async-storage'
import { currentLanguage, i18n, initLanguage, setLanguage } from './index'

vi.mock('@react-native-async-storage/async-storage', () => import('../test-support/async-storage'))

const device = vi.hoisted(() => ({ tags: ['es-CO'] as string[] }))
vi.mock('expo-localization', () => ({ getLocales: () => device.tags.map((languageTag) => ({ languageTag })) }))

beforeEach(async () => {
  resetAsyncStorage()
  device.tags = ['es-CO']
  await setLanguage('en')
})

describe('the language of the app', () => {
  it('starts in the language of the phone when the person chose nothing', async () => {
    await AsyncStorage.removeItem('language:v1')
    expect(await initLanguage()).toBe('es')
    expect(currentLanguage()).toBe('es')
  })

  it('starts in the language the person chose, over the phone', async () => {
    await setLanguage('pt')
    device.tags = ['en-US']
    expect(await initLanguage()).toBe('pt')
  })

  it('takes the second language of the phone when the first is one the app does not have', async () => {
    await setLanguage(null)
    device.tags = ['fr-FR', 'pt-BR']
    expect(await initLanguage()).toBe('pt')
  })

  it('starts in the language of the phone when what was stored is corrupt', async () => {
    await AsyncStorage.setItem('language:v1', '{broken')
    expect(await initLanguage()).toBe('es')
  })

  it('changes without a restart and keeps the choice', async () => {
    await setLanguage('es')
    expect(i18n.t('common:duration.minute', { count: 10 })).toBe('10 minutos')
    await setLanguage('en')
    expect(i18n.t('common:duration.minute', { count: 10 })).toBe('10 minutes')
    await setLanguage('pt')
    expect(JSON.parse((await AsyncStorage.getItem('language:v1')) ?? 'null')).toBe('pt')
  })

  it('goes back to the language of the phone when the choice is cleared', async () => {
    await setLanguage('pt')
    device.tags = ['es-419']
    expect(await setLanguage(null)).toBe('es')
    expect(await AsyncStorage.getItem('language:v1')).toBeNull()
  })

  it('throws, outside production, when a text is rendered without the value one of its placeholders needs', () => {
    i18n.addResourceBundle('en', 'common', { probe: 'Hello {{name}}' }, true, true)
    expect(() => i18n.t('common:probe' as never)).toThrow('No value for name')
    expect(i18n.t('common:probe' as never, { name: 'Ana' } as never)).toBe('Hello Ana')
  })
})
