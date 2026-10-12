import { i18n } from '../../i18n'
import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

import { PermissionsScreen } from './permissions-screen'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
vi.mock('expo-symbols', () => ({ unstable_getMaterialSymbolSourceAsync: async () => ({ uri: 'icon.png' }) }))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const button = (root: ReactTestInstance, label: string) =>
  root.findAll((node) => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel === label)[0]

async function render(
  request: (groups: readonly ('nearby' | 'notifications')[]) => Promise<'granted' | 'denied'>,
  done = vi.fn(),
) {
  const root = (await act(async () => create(<PermissionsScreen request={request} onDone={done} />))).root
  return { root, done }
}

describe('permission screen', () => {
  it('asks for nearby devices and notifications, and continues whatever the answer', async () => {
    const request = vi.fn(async () => 'denied' as const)
    const { root, done } = await render(request)
    expect(button(root, i18n.t('mesh:continue'))).toBeUndefined()
    await act(async () => button(root, i18n.t('mesh:allow')).props.onPress())
    expect(request).toHaveBeenCalledWith(['nearby', 'notifications'])
    expect(button(root, i18n.t('mesh:allow'))).toBeUndefined()
    await act(async () => button(root, i18n.t('mesh:continue')).props.onPress())
    expect(done).toHaveBeenCalledWith({ mesh: false })
  })

  it('starts the mesh only when a Bluetooth permission was granted', async () => {
    const { root, done } = await render(async () => 'granted')
    await act(async () => button(root, i18n.t('mesh:allow')).props.onPress())
    await act(async () => button(root, i18n.t('mesh:continue')).props.onPress())
    expect(done).toHaveBeenCalledWith({ mesh: true })
  })
})
