import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QrScanner } from './qr-scanner'

const camera = vi.hoisted(() => ({
  permission: { granted: true, canAskAgain: true, status: 'granted' } as {
    granted: boolean
    canAskAgain: boolean
    status: string
  } | null,
  request: vi.fn(async () => {}),
  clipboard: '',
}))

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('expo-symbols', () => ({ unstable_getMaterialSymbolSourceAsync: vi.fn(async () => ({ uri: 'icon.png' })) }))
vi.mock('@react-native-async-storage/async-storage', () => import('../../test-support/async-storage'))
vi.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: () => [camera.permission, camera.request],
}))
vi.mock('expo-clipboard', () => ({ getStringAsync: vi.fn(async () => camera.clipboard) }))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const { Linking } = await import('react-native')
const { default: AsyncStorage, resetAsyncStorage } = await import('../../test-support/async-storage')

const mount = async (onText: (text: string) => void) => act(async () => create(<QrScanner onText={onText} />))
const button = (root: ReactTestInstance, label: string) =>
  root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0]
const labels = (root: ReactTestInstance) => root.findAllByType('Text' as never).flatMap((node) => node.props.children)

beforeEach(() => {
  camera.permission = { granted: true, canAskAgain: true, status: 'granted' }
  camera.request.mockClear()
  camera.clipboard = ''
  resetAsyncStorage()
})

describe('QrScanner', () => {
  it('renders the camera for QR codes only', async () => {
    const { root } = await mount(vi.fn())
    expect(root.findByType('CameraView' as never).props.barcodeScannerSettings).toEqual({ barcodeTypes: ['qr'] })
  })

  it('passes the data of every scan to onText', async () => {
    const onText = vi.fn()
    const { root } = await mount(onText)
    const view = root.findByType('CameraView' as never)
    view.props.onBarcodeScanned({ data: 'BP:1' })
    view.props.onBarcodeScanned({ data: 'BP:2' })
    expect(onText.mock.calls).toEqual([['BP:1'], ['BP:2']])
  })

  it('asks for permission once, on mount', async () => {
    const renderer = await mount(vi.fn())
    await act(async () => renderer.update(<QrScanner onText={vi.fn()} />))
    expect(camera.request).toHaveBeenCalledTimes(1)
  })

  it('explains a denied permission, offers Settings and keeps Paste', async () => {
    camera.permission = { granted: false, canAskAgain: false, status: 'denied' }
    const openSettings = vi.spyOn(Linking, 'openSettings')
    const { root } = await mount(vi.fn())
    expect(root.findAllByType('CameraView' as never)).toHaveLength(0)
    expect(labels(root)).toContain('Camera access is off. Allow it in Settings to scan, or paste the code instead.')
    await act(async () => button(root, 'Open Settings').props.onPress())
    expect(openSettings).toHaveBeenCalledTimes(1)
    expect(button(root, 'Paste code')).toBeDefined()
  })

  it('pastes through the same path as a scan', async () => {
    const onText = vi.fn()
    const { root } = await mount(onText)
    camera.clipboard = 'BP:ABC'
    await act(async () => button(root, 'Paste code').props.onPress())
    expect(onText).toHaveBeenCalledWith('BP:ABC')
    expect(labels(root)).not.toContain("That isn't a Buckspay code.")
    camera.clipboard = ''
    await act(async () => button(root, 'Paste code').props.onPress())
    expect(labels(root)).toContain("That isn't a Buckspay code.")
  })

  it('remembers the camera the person chose', async () => {
    const { root } = await mount(vi.fn())
    expect(root.findByType('CameraView' as never).props.facing).toBe('back')
    await act(async () => button(root, 'Use the front camera').props.onPress())
    expect(root.findByType('CameraView' as never).props.facing).toBe('front')
    expect(await AsyncStorage.getItem('qr:facing')).toBe('front')
  })
})
