import { act } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAsyncStorage } from '../test-support/async-storage'
import { currentLanguage, i18n } from '.'
import { saveLanguagePreference } from './preference'
import { useLanguageBootstrap } from './use-language-bootstrap'

vi.mock('@react-native-async-storage/async-storage', () => import('../test-support/async-storage'))
const app = vi.hoisted(() => ({ listeners: [] as ((status: string) => void)[] }))
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (status: string) => void) => {
      app.listeners.push(listener)
      return { remove: () => app.listeners.splice(app.listeners.indexOf(listener), 1) }
    },
  },
}))
const device = vi.hoisted(() => ({ tags: ['es-CO'] as string[] }))
vi.mock('expo-localization', () => ({ getLocales: () => device.tags.map((languageTag) => ({ languageTag })) }))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let renderer: ReactTestRenderer | undefined
function Probe() {
  return <>{String(useLanguageBootstrap())}</>
}
const mount = async () => void (await act(async () => void (renderer = create(<Probe />))))
const ready = () => renderer?.toJSON()
const foreground = () => act(async () => app.listeners.forEach((listener) => listener('active')))

beforeEach(async () => {
  resetAsyncStorage()
  app.listeners.length = 0
  device.tags = ['es-CO']
  renderer = undefined
  await i18n.changeLanguage('en')
})

describe('the language at start', () => {
  it('is ready once the language is chosen: the one saved, or else the phone', async () => {
    await saveLanguagePreference('pt')
    await mount()
    expect(ready()).toBe('true')
    expect(currentLanguage()).toBe('pt')
  })

  it('follows the phone when nothing was chosen', async () => {
    await mount()
    expect(currentLanguage()).toBe('es')
  })

  it('follows the phone again when the app comes back after the phone language changed', async () => {
    await mount()
    device.tags = ['pt-BR']
    await foreground()
    expect(currentLanguage()).toBe('pt')
  })

  it('keeps the language the person chose when the app comes back', async () => {
    await saveLanguagePreference('en')
    await mount()
    device.tags = ['pt-BR']
    await foreground()
    expect(currentLanguage()).toBe('en')
  })
})
