import { afterEach, describe, expect, it, vi } from 'vitest'
import appConfig from './app.config'
import app from './app.json'

const base = { scheme: 'buckspay', plugins: ['expo-router'] }
const resolve = () => appConfig({ config: base } as never) as { scheme: string | string[] }

afterEach(() => vi.unstubAllEnvs())

describe('app config', () => {
  it('registers no deep link scheme for a normal build', () => {
    expect(JSON.stringify(resolve().scheme)).not.toContain('buckspay-e2e')
  })

  it('registers buckspay-e2e only for an end-to-end build', () => {
    vi.stubEnv('EXPO_PUBLIC_E2E', '1')
    expect(resolve().scheme).toEqual(['buckspay', 'buckspay-e2e'])
  })
})

describe('app config zk pins', () => {
  it('carries no pin without a manifest', () => {
    expect((appConfig({ config: base } as never) as { extra: { zk: unknown[] } }).extra.zk).toEqual([])
  })
})

describe('app languages', () => {
  it('offers English, Spanish and Portuguese in the per-app language list of Android', () => {
    const plugin = app.expo.plugins.find((entry) => Array.isArray(entry) && entry[0] === 'expo-localization')
    expect(plugin?.[1]).toEqual({ supportedLocales: { android: ['en', 'es-419', 'pt-BR'] } })
  })
})
