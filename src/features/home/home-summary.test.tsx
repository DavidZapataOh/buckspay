import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HomeSummary } from './home-summary'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('expo-symbols', () => ({ unstable_getMaterialSymbolSourceAsync: vi.fn(async () => ({ uri: 'icon.png' })) }))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const texts = (root: ReactTestInstance) =>
  root.findAllByType('Text' as never).map((node) => [node.props.children].flat().join(''))
const render = async (element: React.ReactElement) => (await act(async () => create(element))).root
const press = (root: ReactTestInstance, testID: string) =>
  act(async () => void root.findAllByProps({ testID })[0].props.onPress())

const onPay = vi.fn()
const onReceive = vi.fn()
const onAdd = vi.fn()
const summary = (allowance: bigint | null) => (
  <HomeSummary
    allowance={allowance}
    symbol="USDC"
    decimals={6}
    onPay={onPay}
    onReceive={onReceive}
    onAddMoney={onAdd}
  />
)

beforeEach(() => {
  onPay.mockClear()
  onReceive.mockClear()
  onAdd.mockClear()
})

describe('HomeSummary', () => {
  it('says what the person can pay without internet and offers Pay and Get paid first', async () => {
    const root = await render(summary(11_440_000n))
    expect(texts(root).join('\n')).toContain('You can pay up to 11.44 USDC without internet')
    await press(root, 'home-pay')
    await press(root, 'home-receive')
    expect(onPay).toHaveBeenCalledTimes(1)
    expect(onReceive).toHaveBeenCalledTimes(1)
  })

  it('asks to add money, with that as the main action, when there is nothing to pay with', async () => {
    const root = await render(summary(0n))
    expect(texts(root).join('\n')).toContain('Add money to pay without internet')
    expect(root.findAllByProps({ testID: 'home-pay' })).toHaveLength(0)
    await press(root, 'home-add-money')
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('claims nothing and moves no button while it does not know yet what the person has', async () => {
    const root = await render(summary(null))
    const shown = texts(root).join('\n')
    expect(shown).toContain('Checking…')
    expect(shown).not.toContain('Add money')
    expect(root.findAllByProps({ testID: 'home-add-money' })).toHaveLength(0)
    await press(root, 'home-pay')
    expect(onPay).toHaveBeenCalledTimes(1)
  })

  it('says what USDC is, because the person may not know it', async () => {
    expect(texts(await render(summary(5_000_000n))).join('\n')).toContain('USDC is digital dollars')
  })

  it('writes no word of the engineering: no wallet address, reserve, deposit or network name', async () => {
    expect(texts(await render(summary(5_000_000n))).join('\n')).not.toMatch(/lock|bond|settle|devnet|registered/i)
  })
})
