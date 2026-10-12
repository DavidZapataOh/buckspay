import { i18n, setLanguage } from '../../i18n'
import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { PlanRefusal } from '../../payment/preflight'

import { PayRefused, refusalAction } from './refusal'

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
      expect(i18n.t(`payment:refusal.${reason}.action`)).not.toBe('')
      const button = renderer.root.findByProps({ testID: 'pay-refused-action' })
      expect(button.props.label).toBe(i18n.t(`payment:refusal.${reason}.action`))
      await act(async () => button.props.onPress())
      expect(onAction).toHaveBeenCalledWith(refusalAction(reason))
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

  it('does what the button says in every language, whatever the button says', async () => {
    const expected = {
      NoLock: 'add-money',
      BondTooSmall: 'add-money',
      AllowanceTooLow: 'add-money',
      LockTooShort: 'add-money',
      AlreadyPaid: 'activity',
      Malformed: 'back',
    } as const
    for (const language of ['en', 'es', 'pt'] as const) {
      await setLanguage(language)
      for (const [reason, action] of Object.entries(expected)) {
        const onAction = vi.fn()
        const renderer = await act(async () =>
          create(
            <PayRefused
              reason={reason as PlanRefusal}
              values={{ max: '1', amount: '1', allowance: '1' }}
              onAction={onAction}
            />,
          ),
        )
        await act(async () => renderer.root.findByProps({ testID: 'pay-refused-action' }).props.onPress())
        expect(onAction, `${language} ${reason}`).toHaveBeenCalledWith(action)
      }
    }
    await setLanguage('en')
  })
})
