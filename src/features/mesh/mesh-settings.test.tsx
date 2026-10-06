import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MeshSettings } from './mesh-settings'
import { meshCopy } from './copy'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('expo-symbols', () => ({ unstable_getMaterialSymbolSourceAsync: async () => ({ uri: 'icon.png' }) }))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

type Props = Parameters<typeof MeshSettings>[0]
const render = async (props: Partial<Props>) => {
  const all: Props = {
    enabled: false,
    problem: undefined,
    warnings: 0,
    onToggle: vi.fn(),
    onOpenSettings: vi.fn(),
    ...props,
  }
  return { all, root: (await act(async () => create(<MeshSettings {...all} />))).root }
}
const texts = (root: ReactTestInstance) => root.findAllByType('Text' as never).map((node) => node.props.children)
const button = (root: ReactTestInstance, label: string) =>
  root.findAll((node) => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel === label)[0]

describe('mesh settings', () => {
  it('shows On and Off and flips the switch', async () => {
    const off = await render({})
    expect(texts(off.root)).toContain(meshCopy.status.off)
    act(() => off.root.findByProps({ testID: 'mesh-switch' }).props.onValueChange(true))
    expect(off.all.onToggle).toHaveBeenCalledWith(true)
    expect(texts((await render({ enabled: true })).root)).toContain(meshCopy.status.on)
  })

  it('counts the warnings this phone received, and says so when there are none', async () => {
    expect(texts((await render({ warnings: 0 })).root)).toContain(meshCopy.warnings(0))
    expect(texts((await render({ warnings: 3 })).root)).toContain('Warnings received: 3')
  })

  it('offers the way out of each problem', async () => {
    const bluetooth = await render({ problem: 'bluetooth-off' })
    expect(texts(bluetooth.root)).toContain(meshCopy.status.bluetoothOff)
    act(() => button(bluetooth.root, meshCopy.turnOn).props.onPress())
    expect(bluetooth.all.onToggle).toHaveBeenCalledWith(true)
    const denied = await render({ problem: 'permission-denied' })
    expect(texts(denied.root)).toContain(meshCopy.status.permissionNeeded)
    act(() => button(denied.root, meshCopy.openSettings).props.onPress())
    expect(denied.all.onOpenSettings).toHaveBeenCalled()
  })
})
