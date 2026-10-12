import { formatMoney } from '../../i18n/format'
import { i18n, currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import * as Haptics from 'expo-haptics'
import { type ReactNode, useEffect } from 'react'
import { AccessibilityInfo, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import type { Reason } from '../../payment/reasons'
import type { Outcome } from '../../payment/receive'

import { reasonText } from '../payment/reason-text'
import { ResultMark } from '../payment/result-mark'

type Accepted = Extract<Outcome, { accepted: true }>

/** The receiver's result for a payment that was stored: what arrived, and the confirmation to show the payer. */
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
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
    AccessibilityInfo.announceForAccessibility(i18n.t('payment:receive.receivedSpoken', { amount: shown, symbol }))
  }, [shown, symbol])
  return (
    <View testID="receive-result-accepted" className="gap-4">
      <ResultMark ok />
      <AppText variant="display" tone="success" accessibilityRole="header">
        {t('payment:receive.received', { amount: shown, symbol })}
      </AppText>
      {outcome.duplicate ? <AppText variant="body">{t('payment:receive.already')}</AppText> : null}
      {requestedAmount !== null && requestedAmount !== amount ? (
        <AppText variant="body">
          {t('payment:receive.differs', {
            asked: formatMoney(requestedAmount, decimals, currentLanguage()),
            got: shown,
            symbol,
          })}
        </AppText>
      ) : null}
      <AppText variant="body">
        {outcome.note.keep ? t('payment:receive.yoursPassOn') : t('payment:receive.yours')}
      </AppText>
      <AppText variant="label" tone="muted">
        {t('payment:receive.bondNote')}
      </AppText>
      {witness}
      {receipt ? (
        <View testID="receive-receipt" className="gap-2">
          <AppText variant="label" tone="muted">
            {t('payment:receive.showConfirmation')}
          </AppText>
          {receipt}
        </View>
      ) : null}
      <Button testID="receive-done" variant="filled" label={t('payment:receive.done')} onPress={onDone} />
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
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)
    AccessibilityInfo.announceForAccessibility(`${i18n.t('payment:receive.notReceived')} ${why}`)
  }, [why])
  return (
    <View testID="receive-result-rejected" className="gap-4">
      <ResultMark ok={false} />
      <AppText variant="headline" tone="danger" accessibilityRole="header">
        {t('payment:receive.notReceived')}
      </AppText>
      <AppText variant="body">{why}</AppText>
      <View className="gap-3">
        <Button testID="receive-retry" variant="filled" label={t('payment:receive.tryAgain')} onPress={onRetry} />
        <Button testID="receive-done" variant="text" label={t('payment:receive.done')} onPress={onDone} />
      </View>
    </View>
  )
}
