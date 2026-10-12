import { formatMoney } from '../../i18n/format'
import { i18n, currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { type ReactNode, useEffect } from 'react'
import { AccessibilityInfo, View } from 'react-native'
import { Amount } from '../../components/amount'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Hero } from '../../components/hero'
import { Info } from '../../components/info'
import { Stage } from '../../components/stage'
import { feedback } from '../../feedback'
import type { Reason } from '../../payment/reasons'
import type { Outcome } from '../../payment/receive'

import { reasonText } from '../payment/reason-text'

type Accepted = Extract<Outcome, { accepted: true }>

/** The receiver's result for a payment that was stored: it arrived, how much, and the confirmation to show the payer. */
export function AcceptedResult({
  outcome,
  symbol,
  decimals,
  receipt,
  witness,
  onDone,
}: {
  outcome: Accepted
  symbol: string
  decimals: number
  /** The confirmation code, shown under the result. */
  receipt?: ReactNode
  /** The nearby check of this payment, when it was asked for. */
  witness?: ReactNode
  onDone: () => void
}) {
  const { t } = useTranslation(NAMESPACES)

  const { amount, requestedAmount } = outcome.note
  const shown = formatMoney(amount, decimals, currentLanguage())
  useEffect(() => {
    feedback.cue('success')
    AccessibilityInfo.announceForAccessibility(i18n.t('payment:receive.receivedSpoken', { amount: shown, symbol }))
  }, [shown, symbol])
  return (
    <View testID="receive-result-accepted" className="items-center gap-4">
      <Stage hero={<Hero kind="done" decorative />} title={t('payment:receive.gotIt')} tone="success">
        <Amount value={shown} symbol={symbol} tone="success" />
        {outcome.duplicate ? <Chip kind="info" label={t('payment:receive.already')} /> : null}
        {requestedAmount !== null && requestedAmount !== amount ? (
          <Chip
            kind="waiting"
            label={t('payment:receive.differs', {
              asked: formatMoney(requestedAmount, decimals, currentLanguage()),
              got: shown,
              symbol,
            })}
          />
        ) : null}
        <View className="flex-row items-center gap-1">
          <AppText variant="body" tone="muted" className="shrink text-center">
            {outcome.note.keep ? t('payment:receive.yoursPassOn') : t('payment:receive.yours')}
          </AppText>
          <Info
            title={t('payment:receive.gotIt')}
            lines={[t('payment:receive.creditedLater'), t('payment:receive.bondNote')]}
          />
        </View>
      </Stage>
      {witness}
      {receipt ? (
        <View testID="receive-receipt" className="items-center gap-2">
          <AppText variant="label" tone="muted">
            {t('payment:receive.showConfirmation')}
          </AppText>
          {receipt}
        </View>
      ) : null}
      <View className="w-full">
        <Button testID="receive-done" variant="filled" label={t('payment:receive.done')} onPress={onDone} />
      </View>
    </View>
  )
}

/** The receiver's result for a payment it did not accept, with the reason and the way to try again. */
export function RejectedResult({
  reason,
  limits,
  why: worded,
  onRetry,
  onDone,
}: {
  reason: Reason
  /** The sentence to show instead of the reason's usual one. */
  why?: string
  limits: { window: number; max: bigint; symbol: string; decimals: number }
  onRetry: () => void
  onDone: () => void
}) {
  const { t } = useTranslation(NAMESPACES)

  const why = worded ?? reasonText(reason, limits)
  useEffect(() => {
    feedback.cue('problem')
    AccessibilityInfo.announceForAccessibility(`${i18n.t('payment:receive.notReceived')} ${why}`)
  }, [why])
  return (
    <View testID="receive-result-rejected" className="gap-4">
      <Stage hero={<Hero kind="problem" decorative />} title={t('payment:receive.notReceived')} line={why} />
      <View className="gap-3">
        <Button testID="receive-retry" variant="filled" label={t('payment:receive.tryAgain')} onPress={onRetry} />
        <Button testID="receive-done" variant="text" label={t('payment:receive.done')} onPress={onDone} />
      </View>
    </View>
  )
}
