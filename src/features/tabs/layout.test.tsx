import { act, type ReactNode } from 'react'
import { create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import TabsLayout from '../../app/(tabs)/_layout'

vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('expo-router/unstable-native-tabs', () => {
  function Trigger({ children }: { name: string; children?: ReactNode }) {
    return <>{children}</>
  }
  Trigger.Label = function Label({ children }: { children?: ReactNode }) {
    return <>{children}</>
  }
  Trigger.Icon = function Icon(_: { md: string }) {
    return null
  }
  function NativeTabs({ children }: { children?: ReactNode }) {
    return <>{children}</>
  }
  return { NativeTabs: Object.assign(NativeTabs, { Trigger }) }
})

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('the tabs', () => {
  it('has five tabs in the order Home, Pay, Receive, Activity, Settings', async () => {
    const renderer = await act(async () => create(<TabsLayout />))
    const triggers = renderer.root.findAll((node) => typeof node.props.name === 'string' && 'children' in node.props)
    expect(triggers.map((trigger) => trigger.props.name)).toEqual(['index', 'pay', 'receive', 'activity', 'settings'])
    const labels = triggers.map((trigger) => {
      const label = trigger.findAll((node) => typeof node.props.children === 'string')[0]
      return label.props.children
    })
    expect(labels).toEqual(['Home', 'Pay', 'Receive', 'Activity', 'Settings'])
  })
})
