import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { PlanRefusal } from '../../payment/preflight'
import { copy } from '../payment/copy'
import { PayRefused } from './refusal'

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

/** Every refusal `planPayment` can give: this list fails to compile when one is added and not listed. */
const reasons = Object.keys({
  Malformed: 0,
  UnknownMint: 0,
  AboveYourLimit: 0,
  SelfPayment: 0,
  ClockOrExpired: 0,
  AlreadyPaid: 0,
  NoLock: 0,
  AttesterNotTrusted: 0,
  BondTooSmall: 0,
  AllowanceTooLow: 0,
  LockTooShort: 0,
  TicketStale: 0,
} satisfies Record<PlanRefusal, 0>) as PlanRefusal[]

describe('PayRefused', () => {
  it('has a text and an action for every PlanRefusal', async () => {
    const seen = new Set<string>()
    for (const reason of reasons) {
      const onAction = vi.fn()
      const renderer = await act(async () =>
        create(
          <PayRefused
            reason={reason}
            values={{ max: '100.00 USDC', amount: '5.00 USDC', allowance: '1.00 USDC' }}
            onAction={onAction}
          />,
        ),
      )
      const shown = texts(renderer.root).join('\n')
      expect(shown.length).toBeGreaterThan(10)
      expect(shown).not.toContain('{')
      expect(copy.refusal[reason].action).not.toBe('')
      const button = renderer.root.findByProps({ testID: 'pay-refused-action' })
      expect(button.props.label).toBe(copy.refusal[reason].action)
      await act(async () => button.props.onPress())
      expect(onAction).toHaveBeenCalledWith(copy.refusal[reason].action)
      seen.add(shown)
    }
    expect(seen.size).toBe(reasons.length)
  })

  it('says the figures of the payer’s own limits and allowance', async () => {
    const renderer = await act(async () =>
      create(
        <PayRefused
          reason="AllowanceTooLow"
          values={{ max: '100.00 USDC', amount: '5.00 USDC', allowance: '1.00 USDC' }}
          onAction={() => {}}
        />,
      ),
    )
    expect(texts(renderer.root).join('\n')).toContain('You only have 1.00 USDC left to pay offline.')
  })
})
