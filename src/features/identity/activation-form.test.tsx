import { address } from '@solana/kit'
import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveProfile } from '../../protocol'
import type { Quote } from '../lock/gateway'
import type { Activation } from './activation'
import { ActivationForm } from './activation-form'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('../../../modules/hardware-keys/src/HardwareKeysModule', () => import('../../keys/test-support/hardware-keys'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const { windows } = resolveProfile({})
const ALICE = address('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS')
const quote = (terms: Partial<Quote>): Quote => ({
  available: true,
  fee: 0n,
  feeMode: 'off',
  minFunding: 5_000_000n,
  pressure: 0,
  maxLockDays: 45,
  reason: null,
  ...terms,
})
const activation = (terms?: Partial<Quote>, sol = 0n): Activation => ({
  funding: { mint: ALICE, tokenProgram: ALICE, account: ALICE, decimals: 6, balance: 100_000_000n },
  quote: terms && quote(terms),
  sol: { balance: sol, cost: 6_204_400n },
  defaultAmount: terms?.minFunding && terms.minFunding > 5_000_000n ? terms.minFunding : 5_000_000n,
  defaultLockDays: 30,
  minLockDays: 15,
  maxLockDays: 365,
})

const onSubmit = vi.fn()
async function render(offer: Activation, sponsorship?: 'free' | 'unavailable') {
  return (
    await act(async () =>
      create(
        <ActivationForm
          activation={offer}
          sponsorship={sponsorship}
          windows={windows}
          busy={false}
          action="Activate"
          onSubmit={onSubmit}
        />,
      ),
    )
  ).root
}
const text = (root: ReactTestInstance, testID: string) =>
  root
    .findByProps({ testID })
    .findAllByType('Text' as never)
    .map((node) => node.props.children)
    .flat()
    .join('')
const field = (root: ReactTestInstance, testID: string) =>
  root.findAllByType('TextInput' as never).find((node) => node.props.testID === testID)!

describe('activation form', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    onSubmit.mockClear()
  })
  afterEach(() => vi.useRealTimers())

  it('shows the funds, that nothing else is charged, and the withdrawal date before the wallet is asked', async () => {
    const root = await render(activation({}), 'free')
    expect(text(root, 'funding-balance')).toBe('Your wallet has 100 USDC.')
    expect(field(root, 'funding-amount').props.value).toBe('5')
    expect(field(root, 'lock-days').props.value).toBe('30')
    expect(text(root, 'funding-minimum')).toBe('The minimum to add is 5 USDC.')
    expect(text(root, 'funding-fee')).toBe('There is no fee.')
    expect(text(root, 'network-cost')).toBe('Buckspay pays the network costs. Your wallet pays nothing else.')
    expect(text(root, 'withdrawal-date')).toBe('You can take your funds back from 2030-02-07 (UTC).')
  })

  it.each([
    [50, 5_000_000n, 90_000n, '5 USDC', 'Buckspay charges a fee of 0.09 USDC, on top of your funds.'],
    [90, 50_000_000n, 150_000n, '50 USDC', 'Buckspay charges a fee of 0.15 USDC, on top of your funds.'],
  ])(
    'shows the current minimum and the forced fee at %i% pressure',
    async (pressure, minFunding, fee, minimum, notice) => {
      const root = await render(activation({ pressure, minFunding, fee, feeMode: 'cost_plus' }), 'free')
      expect(text(root, 'funding-minimum')).toBe(`The minimum to add is ${minimum}.`)
      expect(text(root, 'funding-fee')).toBe(notice)
      expect(field(root, 'funding-amount').props.value).toBe(String(Number(minFunding) / 1_000_000))
    },
  )

  it('says the wallet pays the network below the minimum, and offers to continue that way', async () => {
    const root = await render(
      activation({ minFunding: 50_000_000n, fee: 150_000n, feeMode: 'cost_plus' }, 10_000_000n),
      'free',
    )
    await act(async () => field(root, 'funding-amount').props.onChangeText('10'))
    expect(text(root, 'funding-minimum')).toBe(
      'The minimum to add is 50 USDC. Below it, your wallet pays the network costs.',
    )
    expect(text(root, 'funding-fee')).toBe('There is no fee.')
    expect(text(root, 'network-cost')).toBe('Your wallet pays the network costs, about 0.0063 SOL. Not refundable.')
    expect(root.findAllByProps({ testID: 'sol-shortfall' })).toHaveLength(0)
  })

  it('says what the wallet lacks in SOL when it pays the network itself', async () => {
    const root = await render(activation(undefined, 1_000_000n), undefined)
    expect(text(root, 'network-cost')).toBe('Your wallet pays the network costs, about 0.0063 SOL. Not refundable.')
    expect(text(root, 'sol-shortfall')).toBe('Your wallet has 0.001 SOL. Add SOL to it before you activate.')
    expect(root.findAllByProps({ testID: 'funding-minimum' })).toHaveLength(0)
  })

  it('submits what was typed, and not what cannot be parsed', async () => {
    const root = await render(activation({}), 'free')
    await act(async () => field(root, 'funding-amount').props.onChangeText('7.5'))
    await act(async () => field(root, 'lock-days').props.onChangeText('20'))
    await act(async () => root.findByProps({ testID: 'onboarding-next' }).props.onPress())
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({ amount: 7_500_000n, lockDays: 20 })
    await act(async () => field(root, 'funding-amount').props.onChangeText('seven'))
    expect(root.findByType('Pressable' as never).props.accessibilityState.disabled).toBe(true)
  })
})
