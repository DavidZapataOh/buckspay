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
  it('shows the big amount, a quiet way to add a note, the reusable switch and the button', async () => {
    const root = await render(<ReceiveForm {...base} />)
    const shown = texts(root).join('\n')
    for (const part of ['USDC', 'Add note', 'Reusable money', 'Charge']) expect(shown).toContain(part)
    expect(root.findAllByProps({ testID: 'receive-memo' })).toHaveLength(0)
    await act(async () => void root.findAllByProps({ testID: 'receive-add-note' })[0].props.onPress())
    expect(root.findAllByProps({ testID: 'receive-memo' }).length).toBeGreaterThan(0)
  })

  it('turns the button off without an amount and on with one, and writes no reason beside it', async () => {
    const off = await render(<ReceiveForm {...base} />)
    expect(texts(off).join('\n')).not.toContain('Enter an amount')
    expect(off.findAllByProps({ testID: 'receive-create' })[0].props.disabled).toBe(true)
    const on = await render(<ReceiveForm {...base} amount="0,10" amountValid />)
    expect(on.findAllByProps({ testID: 'receive-create' })[0].props.disabled).toBe(false)
  })

  it('says in two words what is wrong with an amount that was typed and is not accepted', async () => {
    const root = await render(<ReceiveForm {...base} amount="1.000" />)
    expect(texts(root)).toContain('Max 100.00 USDC')
    expect(root.findAllByProps({ testID: 'receive-needs-amount' }).length).toBeGreaterThan(0)
  })

  it('keeps the limits behind the info button and shows no counter of bytes', async () => {
    const root = await render(<ReceiveForm {...base} />)
    const shown = texts(root).join('\n')
    expect(shown).not.toMatch(/bytes|\/ 48/i)
    expect(shown).toContain('100.00 USDC')
    expect(shown).toContain('0.05 USDC')
    expect(root.findAllByProps({ accessibilityLabel: 'More info' }).length).toBeGreaterThan(0)
  })

  it('says a payment below the smallest one the server credits is credited later', async () => {
    const root = await render(<ReceiveForm {...base} amount="0.01" amountValid belowMinimum />)
    expect(texts(root)).toContain('Credited later')
  })
})
