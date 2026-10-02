import * as Clipboard from 'expo-clipboard'
import { openURL } from 'expo-linking'
import { act, type ReactElement } from 'react'
import { Platform, ToastAndroid } from 'react-native'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { AddressRow } from './address-row'
import { AppText } from './app-text'
import { Button } from './button'
import { ListRow } from './list-row'
import { StatusNote } from './status-note'

vi.mock('react-native', () => import('../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('expo-symbols', () => ({ unstable_getMaterialSymbolSourceAsync: vi.fn(async () => ({ uri: 'icon.png' })) }))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('expo-linking', () => ({ openURL: vi.fn() }))
vi.mock('../features/network/use-network', () => ({
  useNetwork: () => ({ getExplorerUrl: (path: string) => `https://explorer.solana.com/${path}?cluster=devnet` }),
}))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const address = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS'

async function render(element: ReactElement) {
  return (await act(async () => create(element))).root
}

const buttons = (root: ReactTestInstance) => root.findAllByType('Pressable' as never)
const texts = (root: ReactTestInstance) => root.findAllByType('Text' as never).flatMap((node) => node.props.children)

describe('AppText', () => {
  it('marks headlines as headers only', async () => {
    const root = await render(
      <>
        <AppText variant="headline">Settings</AppText>
        <AppText variant="body">Body</AppText>
      </>,
    )
    expect(root.findAllByType('Text' as never).map((node) => node.props.accessibilityRole)).toEqual([
      'header',
      undefined,
    ])
  })
})

describe('Button', () => {
  it('is a labelled button with a Material ripple that presses', async () => {
    const onPress = vi.fn()
    const root = await render(<Button variant="filled" label="Set up payments" onPress={onPress} />)
    const [button] = buttons(root)
    expect(button.props).toMatchObject({
      accessibilityRole: 'button',
      accessibilityLabel: 'Set up payments',
      accessibilityState: { disabled: false, busy: false },
      android_ripple: { color: '#0000001f', foreground: true },
      disabled: false,
    })
    button.props.onPress()
    expect(onPress).toHaveBeenCalledOnce()
  })

  it('draws the tonal variant on the secondary container', async () => {
    const root = await render(<Button variant="tonal" label="Forget wallet on this phone" onPress={() => {}} />)
    expect(buttons(root)[0].props.className).toContain('bg-secondary-container')
    expect(root.findByType('Text' as never).props.className).toContain('text-on-secondary-container')
  })

  it('is disabled and says so while busy', async () => {
    const root = await render(<Button variant="filled" label="Register this phone" busy onPress={() => {}} />)
    const [button] = buttons(root)
    expect(button.props).toMatchObject({
      accessibilityLabel: 'Register this phone',
      accessibilityState: { disabled: true, busy: true },
      disabled: true,
    })
    expect(root.findByType('ActivityIndicator' as never).props.accessibilityLabel).toBe('Working')
  })
})

describe('AddressRow', () => {
  it('labels both actions, shortens with an ellipsis and acts on the address', async () => {
    const root = await render(<AddressRow address={address} label="Wallet" />)
    const [copy, explorer] = buttons(root)
    expect([copy, explorer].map((node) => [node.props.accessibilityRole, node.props.accessibilityLabel])).toEqual([
      ['button', 'Copy address'],
      ['button', 'Open in explorer'],
    ])
    expect(texts(root)).toEqual(['Wallet', 'Fg6P…sLnS'])
    expect(texts(root).join('')).not.toMatch(/\p{Extended_Pictographic}/u)
    await act(async () => copy.props.onPress())
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(address)
    explorer.props.onPress()
    expect(openURL).toHaveBeenCalledWith(`https://explorer.solana.com/address/${address}?cluster=devnet`)
  })

  it('says the address was copied where Android does not (before Android 13)', async () => {
    const show = vi.spyOn(ToastAndroid, 'show')
    const [copy] = buttons(await render(<AddressRow address={address} label="Wallet" />))
    await act(async () => copy.props.onPress())
    expect(show).not.toHaveBeenCalled()
    Platform.Version = 32
    await act(async () => copy.props.onPress())
    expect(show).toHaveBeenCalledExactlyOnceWith('Address copied', ToastAndroid.SHORT)
    Platform.Version = 36
  })

  it('renders each icon once however many rows show it', async () => {
    // A fresh module, so that no earlier test has rendered its icons yet.
    vi.resetModules()
    const { AddressRow: Row } = await import('./address-row')
    const symbols = vi.mocked((await import('expo-symbols')).unstable_getMaterialSymbolSourceAsync)
    symbols.mockClear()
    await render(
      <>
        <Row address={address} label="Wallet" />
        <Row address={address} label="Program" />
      </>,
    )
    expect(symbols.mock.calls.map(([name]) => name).sort()).toEqual(['content_copy', 'open_in_new'])
  })
})

describe('ListRow', () => {
  it('is read as one element', async () => {
    const root = await render(<ListRow testID="row" title="Version" value="1.0.0" />)
    expect(root.findByType('View' as never).props).toMatchObject({ testID: 'row', accessible: true })
  })
})

describe('StatusNote', () => {
  it('stays mounted as a polite live region, so a message that appears is announced', async () => {
    const renderer = await act(async () => create(<StatusNote tone="danger" />))
    const note = () => renderer.root.findByType('Text' as never)
    expect(note().props).toMatchObject({ accessibilityLiveRegion: 'polite', children: '' })
    await act(async () => renderer.update(<StatusNote tone="danger" message="The wallet declined." />))
    expect(note().props).toMatchObject({ accessibilityLiveRegion: 'polite', children: 'The wallet declined.' })
  })
})
