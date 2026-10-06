import { act } from 'react'
import { create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { TransportEntry } from './registry'
import { HowControl } from './how-control'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const ready = { ready: true as const }
const off = (reason: 'disabled' | 'permission-denied') => ({ ready: false as const, reason })
const e = (id: 'qr' | 'nfc' | 'nearby'): TransportEntry => ({ id, label: id, check: async () => ready, start: vi.fn() })

const mount = async (props: Parameters<typeof HowControl>[0]) => {
  let renderer!: ReturnType<typeof create>
  await act(async () => {
    renderer = create(<HowControl {...props} />)
  })
  return renderer
}
const tabs = (r: ReturnType<typeof create>) =>
  r.root.findAll((n) => n.props.accessibilityRole === 'tab' && typeof n.type === 'string')
const words = (r: ReturnType<typeof create>) =>
  r.root.findAllByType('Text' as never).map((n) => [n.props.children].flat().join(''))

describe('HowControl', () => {
  it('renders nothing with one ready medium', async () => {
    const r = await mount({
      offered: [
        { entry: e('qr'), availability: ready },
        { entry: e('nfc'), availability: off('disabled') },
      ],
      chosen: 'qr',
      onChoose: () => {},
    })
    expect(tabs(r)).toHaveLength(0)
  })

  it('offers the ready media with their labels and reports the choice', async () => {
    const onChoose = vi.fn()
    const r = await mount({
      offered: [
        { entry: e('qr'), availability: ready },
        { entry: e('nearby'), availability: ready },
      ],
      chosen: 'qr',
      onChoose,
    })
    expect(tabs(r).map((t) => t.props.accessibilityLabel)).toEqual(['Code', 'Nearby'])
    await act(async () => tabs(r)[1].props.onPress())
    expect(onChoose).toHaveBeenCalledWith('nearby')
    expect(tabs(r)[0].props.accessibilityState.selected).toBe(true)
  })

  it('explains a medium that is off and can be turned on', async () => {
    const r = await mount({
      offered: [
        { entry: e('qr'), availability: ready },
        { entry: e('nfc'), availability: ready },
        { entry: e('nearby'), availability: off('disabled') },
      ],
      chosen: 'qr',
      onChoose: () => {},
    })
    expect(words(r).join(' ')).toMatch(/Bluetooth/)
  })
})
