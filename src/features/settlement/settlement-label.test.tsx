import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { SettlementLabel } from './settlement-label'

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

describe('SettlementLabel', () => {
  it('says what settling in the clear publishes and what waiting costs, and goes on only when told to', async () => {
    const onContinue = vi.fn()
    const renderer = await act(async () =>
      create(<SettlementLabel count={2} earliestExpiry={1_900_000_000} onContinue={onContinue} />),
    )
    const shown = texts(renderer.root).join('\n')
    expect(shown).toContain(
      'publishes the keys of the people it passed through, every amount, and the account that is paid',
    )
    expect(shown).toContain("Buckspay's server sees this payment, your network address and the time.")
    expect(shown).toMatch(/2 payments are waiting for you to settle them, by /)
    expect(onContinue).not.toHaveBeenCalled()
    await act(async () => host(renderer.root, 'settlement-continue')[0].props.onPress())
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('keeps saying what waiting costs after Not now, and offers nothing more to tap', async () => {
    const renderer = await act(async () =>
      create(<SettlementLabel count={1} earliestExpiry={1_900_000_000} onContinue={() => {}} />),
    )
    await act(async () => host(renderer.root, 'settlement-not-now')[0].props.onPress())
    expect(host(renderer.root, 'settlement-continue')).toHaveLength(0)
    expect(host(renderer.root, 'settlement-waiting')).toHaveLength(1)
  })
})
