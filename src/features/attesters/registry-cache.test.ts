import { beforeEach, describe, expect, it, vi } from 'vitest'
import { address, getAddressEncoder } from '@solana/kit'
import AsyncStorage, { resetAsyncStorage } from '../../test-support/async-storage'
import { ATTESTER } from '../../payment/testing/world'
import { loadRegistry, parseTrusted, saveRegistry } from './registry-cache'

vi.mock('@react-native-async-storage/async-storage', () => import('../../test-support/async-storage'))

beforeEach(() => resetAsyncStorage())

describe('the attester cache', () => {
  it('keeps what the wallet believes across restarts, and the amounts exactly', async () => {
    const attester = { ...ATTESTER, stake: 2n ** 60n + 1n, relied: 5n }
    await saveRegistry([attester])
    expect(await loadRegistry()).toEqual([{ ...attester, relied: 0n }])
  })

  it('is empty when nothing was saved or what was saved cannot be read', async () => {
    expect(await loadRegistry()).toEqual([])
    await AsyncStorage.setItem('attesters:v1', '{"nonsense":true}')
    expect(await loadRegistry()).toEqual([])
    await AsyncStorage.setItem('attesters:v1', 'not json')
    expect(await loadRegistry()).toEqual([])
  })
})

describe('the attesters pinned in a build', () => {
  const authority = address('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS')
  const mint = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
  const encode = (value: string) => Uint8Array.from(getAddressEncoder().encode(address(value)))

  it('are read from the build setting as an id, an authority and a mint', () => {
    const trusted = parseTrusted(JSON.stringify([{ id: 1, authority, mint }]))
    expect(trusted).toEqual([{ id: 1, authority: encode(authority), mint: encode(mint) }])
  })

  it('are none when the build pinned none, and an error when it pinned something unreadable', () => {
    expect(parseTrusted(undefined)).toEqual([])
    expect(() => parseTrusted('[{"id":1}]')).toThrow()
    expect(() => parseTrusted('nonsense')).toThrow()
    expect(() => parseTrusted(JSON.stringify([{ id: 70_000, authority, mint }]))).toThrow()
  })
})
