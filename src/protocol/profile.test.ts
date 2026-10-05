import { afterEach, describe, expect, it, vi } from 'vitest'
import vectors from '../../anchor/crates/protocol/tests/vectors/v1.json'
import { resolveProfile } from './profile'

describe('profiles', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('takes the production program and windows by default', () => {
    const profile = resolveProfile({})
    expect(profile.name).toBe('production')
    expect(profile.programId).toBe(vectors.profiles.production.programIds.devnet)
    expect(profile.windows).toEqual(vectors.profiles.production.windows)
  })

  it('takes the short program and its windows of a minute', () => {
    const profile = resolveProfile({ profile: 'short', programId: vectors.profiles.short.programId })
    expect(profile).toMatchObject({ name: 'short', programId: vectors.profiles.short.programId })
    expect(profile.windows).toEqual(vectors.profiles.short.windows)
    expect(profile.windows.claimWindow).toBe(60)
  })

  it('refuses a program id that is not the profile’s', () => {
    expect(() =>
      resolveProfile({ profile: 'short', programId: vectors.profiles.production.programIds.devnet }),
    ).toThrow(/EXPO_PUBLIC_PROGRAM_ID is not the program of the short profile/)
    expect(() => resolveProfile({ profile: 'production', programId: vectors.profiles.short.programId })).toThrow(
      /EXPO_PUBLIC_PROGRAM_ID is not the program of the production profile/,
    )
    expect(() => resolveProfile({ programId: vectors.profiles.short.programId })).toThrow(/production profile/)
  })

  it('refuses an unknown profile, and the short profile on mainnet', () => {
    expect(() => resolveProfile({ profile: 'staging' })).toThrow(/EXPO_PUBLIC_PROFILE must be production or short/)
    expect(() => resolveProfile({ profile: 'short', cluster: 'mainnet' })).toThrow(
      /short profile exists on devnet only/,
    )
    expect(() => resolveProfile({ cluster: 'mainnet' })).toThrow(/No program is deployed on mainnet/)
  })

  it('stops the app at load when its environment disagrees', async () => {
    vi.stubEnv('EXPO_PUBLIC_PROFILE', 'short')
    vi.stubEnv('EXPO_PUBLIC_PROGRAM_ID', vectors.profiles.production.programIds.devnet)
    await expect(import('./active-profile')).rejects.toThrow(/short profile/)
    vi.resetModules()
    vi.stubEnv('EXPO_PUBLIC_PROGRAM_ID', vectors.profiles.short.programId)
    const { ACTIVE_PROFILE } = await import('./active-profile')
    expect(ACTIVE_PROFILE.name).toBe('short')
  })
})
