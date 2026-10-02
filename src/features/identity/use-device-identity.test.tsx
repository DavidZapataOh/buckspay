import { bytesToHex } from '@noble/hashes/utils.js'
import { findDevicePda } from '@project/anchor'
import { address } from '@solana/kit'
import { MobileWalletProvider, type WalletAuthorizationCache } from '@wallet-ui/react-native-kit'
import { act } from 'react'
import { create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureDeviceKey, createDeviceKey } from '../../keys'
import HardwareKeys, { resetHardwareKeys } from '../../keys/test-support/hardware-keys'
import AsyncStorage, { resetAsyncStorage } from '../../test-support/async-storage'
import { type BuildNetwork, getBuildNetwork } from '../network/build-network'
import { createAuthorizationCache } from '../wallet/authorization-cache'
import { type DeviceIdentity, DeviceIdentityProvider, useDeviceIdentity } from './use-device-identity'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('../../../modules/hardware-keys/src/HardwareKeysModule', () => import('../../keys/test-support/hardware-keys'))
vi.mock('@react-native-async-storage/async-storage', () => import('../../test-support/async-storage'))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const localnet = getBuildNetwork('localnet')
const identity = { name: 'Buckspay', uri: 'https://buckspay.xyz', icon: 'favicon.png' }
const account = { address: address('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'), addressBase64: '', label: '' }

let seen: DeviceIdentity[]
function Probe() {
  seen.push(useDeviceIdentity())
  return null
}

/** The provider tree of the app's layout; `render` is a prop only so that the test can re-render it. */
function App({ build = localnet, cache }: { build?: BuildNetwork; cache: WalletAuthorizationCache; render: number }) {
  return (
    <MobileWalletProvider cache={cache} cluster={build.network} identity={identity}>
      <DeviceIdentityProvider build={build} cache={cache}>
        <Probe />
      </DeviceIdentityProvider>
    </MobileWalletProvider>
  )
}

const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)))

describe('device identity provider', () => {
  beforeEach(() => {
    resetHardwareKeys()
    resetAsyncStorage()
    configureDeviceKey('devnet')
    vi.restoreAllMocks()
    seen = []
  })

  it('is loading until the cached authorization has been read', async () => {
    const cache = createAuthorizationCache(localnet.network.id)
    const { promise: read, resolve } = Promise.withResolvers<void>()
    vi.spyOn(cache, 'get').mockImplementation(async () => {
      await read
      return undefined
    })
    const renderer = await act(async () => create(<App cache={cache} render={0} />))
    await settled()
    expect(seen.at(-1)).toMatchObject({ step: 'loading', busy: true })
    await act(async () => resolve())
    expect(seen.at(-1)).toMatchObject({ step: 'connect', busy: false })
    await act(async () => renderer.unmount())
  })

  it('derives the identity once however often the app above it renders', async () => {
    const cache = createAuthorizationCache(localnet.network.id)
    await cache.set({ accounts: [account], authToken: 'token', selectedAccount: account })
    const getKey = vi.spyOn(HardwareKeys, 'getKey')
    const renderer = await act(async () => create(<App cache={cache} render={0} />))
    for (let render = 1; render <= 5; render++) {
      await act(async () => renderer.update(<App cache={cache} render={render} />))
    }
    await settled()
    expect(seen.at(-1)).toMatchObject({ step: 'create-key', wallet: account.address, busy: false })
    expect(getKey).toHaveBeenCalledTimes(1)
    await act(async () => renderer.unmount())
  })

  it('is ready without a connection once it has seen the registration', async () => {
    // Nothing listens on this port: every request fails as it does offline.
    const offline = { ...localnet, network: { ...localnet.network, url: 'http://127.0.0.1:9' } }
    const cache = createAuthorizationCache(offline.network.id)
    await cache.set({ accounts: [account], authToken: 'token', selectedAccount: account })
    const { publicKey } = await createDeviceKey()
    const [device] = await findDevicePda(publicKey)
    await AsyncStorage.setItem(
      'device',
      JSON.stringify({
        chain: offline.network.id,
        address: device,
        wallet: account.address,
        key: bytesToHex(publicKey),
      }),
    )
    const renderer = await act(async () => create(<App build={offline} cache={cache} render={0} />))
    await settled()
    expect(seen.at(-1)).toMatchObject({
      step: 'ready',
      wallet: account.address,
      device: { address: device, wallet: account.address },
      busy: false,
    })
    expect(seen.at(-1)?.error).toBeUndefined()
    await act(async () => renderer.unmount())
  })
})
