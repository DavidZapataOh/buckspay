import { act, useEffect } from 'react'
import { create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useSyncReducer } from './use-sync-reducer'

vi.mock('react-native', () => import('../../test-support/react-native'))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Action = { type: 'add'; by: number } | { type: 'noop' }
const reducer = (state: number, action: Action) => (action.type === 'add' ? state + action.by : state)

let current: ReturnType<typeof useSyncReducer<number, Action>>
let renders = 0

function Probe() {
  const value = useSyncReducer(reducer, 0)
  useEffect(() => {
    current = value
    renders++
  })
  return null
}

const mount = () => act(async () => void create(<Probe />))

describe('useSyncReducer', () => {
  it('renders the state the reducer returns', async () => {
    await mount()
    await act(async () => current[1]({ type: 'add', by: 2 }))
    expect(current[0]).toBe(2)
  })

  it('reads the new state right after a dispatch, before the next render', async () => {
    await mount()
    await act(async () => {
      current[1]({ type: 'add', by: 1 })
      expect(current[2]()).toBe(1)
      current[1]({ type: 'add', by: 4 })
      expect(current[2]()).toBe(5)
    })
    expect(current[0]).toBe(5)
  })

  it('does not render again for an action that leaves the state as it is', async () => {
    await mount()
    const before = renders
    await act(async () => current[1]({ type: 'noop' }))
    expect(renders).toBe(before)
  })

  it('keeps the same dispatch and read functions across renders', async () => {
    await mount()
    const [, dispatch, read] = current
    await act(async () => current[1]({ type: 'add', by: 1 }))
    expect(current[1]).toBe(dispatch)
    expect(current[2]).toBe(read)
  })
})
