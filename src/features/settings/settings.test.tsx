import { address } from '@solana/kit'
import { act, type ComponentProps } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureDeviceKey, createDeviceKey, type DeviceKey } from '../../keys'
import { resetHardwareKeys } from '../../keys/test-support/hardware-keys'
import { SOFTWARE_KEY_WARNING } from '../identity/identity-copy'
import type { DeviceIdentity } from '../identity/use-device-identity'
import { Settings } from './settings'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
vi.mock('expo-symbols', () => ({ unstable_getMaterialSymbolSourceAsync: async () => ({ uri: 'icon.png' }) }))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('expo-linking', () => ({ openURL: vi.fn() }))
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0.0' } } }))
vi.mock('../network/use-network', () => ({ useNetwork: () => ({ getExplorerUrl: (path: string) => path }) }))
vi.mock('../../../modules/hardware-keys/src/HardwareKeysModule', () => import('../../keys/test-support/hardware-keys'))
const identity = vi.hoisted(() => ({ current: undefined as unknown as DeviceIdentity }))
vi.mock('../identity/use-device-identity', () => ({ useDeviceIdentity: () => identity.current }))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const wallet = address('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS')
const actions = { next: async () => {}, disconnect: async () => {}, reset: async () => {} }

async function render(
  state: Omit<DeviceIdentity, 'next' | 'disconnect' | 'reset'> & Partial<DeviceIdentity>,
  payments?: ComponentProps<typeof Settings>['payments'],
) {
  identity.current = { ...actions, ...state }
  return (await act(async () => create(<Settings payments={payments} />))).root
}

const row = (root: ReactTestInstance, testID: string) =>
  root
    .findByProps({ testID, accessible: true })
    .findAllByType('Text' as never)
    .map((node) => node.props.children)
const texts = (root: ReactTestInstance) => root.findAllByType('Text' as never).map((node) => node.props.children)

describe('Settings', () => {
  let deviceKey: DeviceKey

  beforeEach(async () => {
    resetHardwareKeys()
    configureDeviceKey('devnet')
    deviceKey = await createDeviceKey()
  })

  it('names the network, the wallet this phone is registered to and how its key is protected', async () => {
    const disconnect = vi.fn(async () => {})
    const device = { address: wallet, wallet, key: deviceKey.publicKey }
    const root = await render({ step: 'ready', wallet, deviceKey, device, busy: false, disconnect })
    expect(row(root, 'network')).toEqual(['Network', 'Devnet · test network'])
    expect(root.findAllByProps({ accessibilityLabel: `Registered to: ${wallet}` })).toHaveLength(1)
    expect(row(root, 'security-level')).toEqual(['Key protection', 'Software only'])
    expect(texts(root)).toContain(SOFTWARE_KEY_WARNING)
    expect(texts(root)).toContain('Technical details')
    const forget = root.findByProps({ testID: 'disconnect', accessibilityRole: 'button' })
    expect(forget.props.accessibilityLabel).toBe('Forget wallet on this phone')
    await act(async () => forget.props.onPress())
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('still shows the registration once the wallet is forgotten, with nothing to forget', async () => {
    const device = { address: wallet, wallet, key: deviceKey.publicKey }
    const root = await render({ step: 'connect', deviceKey, device, busy: false })
    expect(row(root, 'wallet')).toEqual(['Connected wallet', 'Not connected'])
    expect(root.findAllByProps({ accessibilityLabel: `Registered to: ${wallet}` })).toHaveLength(1)
    expect(root.findAllByProps({ testID: 'disconnect' })).toHaveLength(0)
  })

  it('lists the limits, what an uninstall loses and the way to reset the identity', async () => {
    const onReset = vi.fn()
    const onAnswer = vi.fn()
    const device = { address: wallet, wallet, key: deviceKey.publicKey }
    const root = await render(
      { step: 'ready', wallet, deviceKey, device, busy: false },
      {
        unsettled: 3,
        onReset,
        onEvents: vi.fn(),
        limits: {
          perPayment: '100.00 USDC',
          biometricFrom: '20.00 USDC',
          biometricDaily: '50.00 USDC',
          window: '1 hour',
        },
        nearbyCheck: {
          answer: false,
          ask: true,
          audible: false,
          requireFrom: '',
          onAnswer: onAnswer,
          onAsk: vi.fn(),
          onAudible: vi.fn(),
          onRequireFrom: vi.fn(),
        },
      },
    )
    await act(async () =>
      root
        .findByProps({ testID: 'nearby-answer', accessibilityLabel: 'Answer nearby checks' })
        .props.onValueChange(true),
    )
    expect(onAnswer).toHaveBeenCalledWith(true)
    expect(row(root, 'limit-per-payment')).toEqual(['Most per payment', '100.00 USDC'])
    expect(row(root, 'limit-window')).toEqual(['Payments you receive must stay valid for', '1 hour'])
    expect(row(root, 'uninstall')).toEqual([
      'If you uninstall or reset',
      "Uninstalling this app loses payments that haven't settled yet. You have 3 right now.",
    ])
    await act(async () => root.findByProps({ testID: 'reset-identity', accessibilityRole: 'button' }).props.onPress())
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('shows none of it where payments are not set up', async () => {
    const root = await render({ step: 'loading', busy: true })
    expect(root.findAllByProps({ testID: 'uninstall' })).toHaveLength(0)
    expect(root.findAllByProps({ testID: 'reset-identity' })).toHaveLength(0)
  })

  it('shows checking rows, without a spinner, while it reads them', async () => {
    const root = await render({ step: 'loading', busy: true })
    for (const [testID, title] of [
      ['wallet', 'Connected wallet'],
      ['registered-to', 'Registered to'],
      ['security-level', 'Key protection'],
    ]) {
      expect(row(root, testID)).toEqual([title, 'Checking…'])
    }
    expect(root.findAllByType('ActivityIndicator' as never)).toHaveLength(0)
  })
})
