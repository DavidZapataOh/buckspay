import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { ReceiveForm, type ReceiveFormProps } from './receive-form'

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

const base: ReceiveFormProps = {
  amount: '',
  onAmountChange: vi.fn(),
  memo: '',
  onMemoChange: vi.fn(),
  passOn: false,
  onPassOnChange: vi.fn(),
  amountValid: false,
  belowMinimum: false,
  onShow: vi.fn(),
  minimumText: '0.05 USDC',
  symbol: 'USDC',
  maxText: '100.00 USDC',
  windowText: '1 hour',
}

describe('ReceiveForm', () => {
  it('shows the amount, an optional note, the option to use the money again with its help, and the button', async () => {
    const shown = texts(await render(<ReceiveForm {...base} />)).join('\n')
    for (const part of [
      'Amount',
      'Note',
      'Accept money I can use again',
      'Use it to pay someone else',
      'Show payment request',
    ])
      expect(shown).toContain(part)
  })

  it('says why the button is off when there is no valid amount, and drops the reason when there is one', async () => {
    const off = await render(<ReceiveForm {...base} />)
    expect(texts(off).join('\n')).toContain('Enter an amount')
    expect(off.findAllByProps({ testID: 'receive-create' })[0].props.disabled).toBe(true)
    const on = await render(<ReceiveForm {...base} amount="0,10" amountValid />)
    expect(texts(on).join('\n')).not.toContain('Enter an amount')
    expect(on.findAllByProps({ testID: 'receive-create' })[0].props.disabled).toBe(false)
  })

  it('keeps the limits out of sight until the person asks, and shows no counter of bytes', async () => {
    const root = await render(<ReceiveForm {...base} />)
    expect(texts(root).join('\n')).not.toMatch(/bytes|bond|settle|server|\/ 48/i)
    expect(texts(root).join('\n')).not.toContain('100.00 USDC')
    await act(async () => void root.findAllByProps({ testID: 'receive-more' })[0].props.onPress())
    expect(texts(root).join('\n')).toContain('100.00 USDC')
    expect(texts(root).join('\n')).toContain('0.05 USDC')
  })

  it('says a payment below the smallest one the server credits is credited later', async () => {
    const root = await render(<ReceiveForm {...base} amount="0.01" amountValid belowMinimum />)
    expect(texts(root).join('\n')).toContain('Smaller payments are credited later')
  })
})
