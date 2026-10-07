import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { PrivateSettlementCard } from './private-settlement-card'
import type { PrivateSettlementState } from '../zk/types'

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

const texts = (root: ReactTestInstance) =>
  root.findAllByType('Text' as never).map((node) => [node.props.children].flat().join(''))
const host = (root: ReactTestInstance, id: string) =>
  root.findAll((node) => node.props.testID === id && typeof node.type === 'string')

async function render(state: PrivateSettlementState, clearAllowed = false) {
  const onSettleNow = vi.fn()
  const onSettleInClear = vi.fn()
  const renderer = await act(async () =>
    create(
      <PrivateSettlementCard
        state={state}
        clearAllowed={clearAllowed}
        onSettleNow={onSettleNow}
        onSettleInClear={onSettleInClear}
      />,
    ),
  )
  return { root: renderer.root, onSettleNow, onSettleInClear }
}

describe('PrivateSettlementCard', () => {
  it('shows progress and lets the user prove now', async () => {
    const { root, onSettleNow } = await render({ kind: 'waiting-for-charger', proved: 3, total: 17 })
    expect(texts(root)).toContain('Preparing private settlement · 3 of 17')
    await act(async () => host(root, 'private-settle-now')[0].props.onPress())
    expect(onSettleNow).toHaveBeenCalled()
    expect(host(root, 'private-settle-clear')).toHaveLength(0)
  })

  it('says the key is downloading, with its progress', async () => {
    const { root } = await render({ kind: 'needs-key', progress: 0.42 })
    expect(texts(root)).toContain('Downloading private settlement data · 42%')
  })

  it('offers the clear fallback only when allowed, and says what it publishes', async () => {
    const { root, onSettleInClear } = await render({ kind: 'failed', reason: 'stale-key' }, true)
    expect(texts(root)).toContain('Updating private settlement data')
    await act(async () => host(root, 'private-settle-clear')[0].props.onPress())
    expect(onSettleInClear).toHaveBeenCalled()
    expect(texts(root).join(' ')).toContain('publishes')
  })

  it('never claims more than the route gives', async () => {
    for (const state of [
      { kind: 'ready' },
      { kind: 'submitting' },
      { kind: 'proving', proved: 1, total: 4 },
      { kind: 'settled', signature: 's' },
    ] as PrivateSettlementState[]) {
      const { root } = await render(state)
      const text = texts(root).join(' ').toLowerCase()
      expect(text).not.toContain('private payment')
      expect(text).not.toContain('untraceable')
    }
  })

  it('explains the route in the words the product allows', async () => {
    const { root } = await render({ kind: 'ready' })
    expect(texts(root).join(' ')).toContain('hidden from chain observers when settled through ZK')
  })
})
