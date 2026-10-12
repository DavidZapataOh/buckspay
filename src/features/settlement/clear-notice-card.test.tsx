import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { ClearNotice } from './clear-notice-card'

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

describe('ClearNotice', () => {
  it('says how many people settling publishes and settles or waits only when told to', async () => {
    const onSettle = vi.fn()
    const onWait = vi.fn()
    const renderer = await act(async () => create(<ClearNotice holders={3} onSettle={onSettle} onWait={onWait} />))
    expect(texts(renderer.root).join('\n')).toContain(
      'makes public the 3 people who held the money before you, and the amounts.',
    )
    expect(onSettle).not.toHaveBeenCalled()
    await act(async () => host(renderer.root, 'notice-wait')[0].props.onPress())
    expect(onWait).toHaveBeenCalledOnce()
    await act(async () => host(renderer.root, 'notice-settle')[0].props.onPress())
    expect(onSettle).toHaveBeenCalledOnce()
  })

  it('speaks of one person in the singular', async () => {
    const renderer = await act(async () => create(<ClearNotice holders={1} onSettle={() => {}} onWait={() => {}} />))
    expect(texts(renderer.root).join('\n')).toContain('who held the money before you, and the amounts.')
  })
})
