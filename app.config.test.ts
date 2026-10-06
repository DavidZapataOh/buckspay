import { afterEach, describe, expect, it, vi } from 'vitest'
import appConfig from './app.config'

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
