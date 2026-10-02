import { address } from '@solana/kit'
import type { WalletAuthorization } from '@wallet-ui/react-native-kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAsyncStorage, storedItems } from '../../test-support/async-storage'
import { createAuthorizationCache } from './authorization-cache'

vi.mock('@react-native-async-storage/async-storage', () => import('../../test-support/async-storage'))

const account = {
  address: address('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'),
  addressBase64: '2ImvgaiDsWyoqGU1lGr6U/gIa0eV5jScOV+JRMtaHu0=',
  label: 'Fg6PaFpo..zPFsLnS',
}
const authorization: WalletAuthorization = { accounts: [account], authToken: 'token', selectedAccount: account }

describe('wallet authorization cache', () => {
  beforeEach(resetAsyncStorage)

  it('keeps one authorization per chain', async () => {
    const devnet = createAuthorizationCache('solana:devnet')
    const localnet = createAuthorizationCache('solana:localnet')
    await devnet.set(authorization)
    expect(await devnet.get()).toEqual(authorization)
    expect(await localnet.get()).toBeUndefined()
    expect(Object.keys(storedItems())).toEqual(['auth:solana:devnet'])
  })

  it('forgets an authorization when cleared or unreadable', async () => {
    const cache = createAuthorizationCache('solana:devnet')
    await cache.set(authorization)
    await cache.clear()
    expect(await cache.get()).toBeUndefined()
    await (await import('../../test-support/async-storage')).default.setItem('auth:solana:devnet', '{')
    expect(await cache.get()).toBeUndefined()
  })
})
