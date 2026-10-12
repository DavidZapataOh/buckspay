import { formatDate, formatMoney } from '../../i18n/format'
import { i18n, currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { router } from 'expo-router'
import { useEffect } from 'react'
import { AccessibilityInfo, View } from 'react-native'
import { Amount } from '../../components/amount'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Hero } from '../../components/hero'
import { Info } from '../../components/info'
import { Screen } from '../../components/screen'
import { Stage } from '../../components/stage'
import { feedback } from '../../feedback'
import { decodeBundle } from '../../payment/messages'
import type { SentPayment } from '../../payment/pay'
import { nativeErrorCode } from '../../keys'
import { MIN_WINDOW, PAY_LIMITS } from '../../features/pay/limits'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { usePayFlow } from '../../features/pay/use-pay-flow'
import { payErrorKey } from '../../features/payment/copy'
import { reasonText } from '../../features/payment/reason-text'
import { QrPresenter } from '../../features/qr/qr-presenter'
import { ScanScreen } from '../../features/qr/scan-screen'
import { WaitingScreen } from '../../features/transport/waiting'
import { NearbyCheck } from '../../features/witness/nearby-check'

const money = (units: bigint) => formatMoney(units, BUILD_TOKEN.decimals, currentLanguage())
const STEPS = { total: 3, current: 2 }

function issueOf(payment: SentPayment) {
  try {
    return decodeBundle(payment.bundle).issue.message
  } catch {
    return undefined
  }
}

export default function PaySend() {
  const { t } = useTranslation(NAMESPACES)

  const flow = usePayFlow()
  const { state } = flow

  useEffect(() => {
    if (state.name === 'idle') router.back()
  }, [state.name])

  useEffect(() => {
    if (state.name === 'confirmed') {
      feedback.cue('success')
      AccessibilityInfo.announceForAccessibility(
        i18n.t('payment:send.confirmedSpoken', { amount: money(state.payment.amount), symbol: BUILD_TOKEN.symbol }),
      )
    } else if (state.name === 'rejected' || state.name === 'failed') feedback.cue('problem')
  }, [state])

  const unconfirmed = state.name === 'presenting' && state.unconfirmed === true
  useEffect(() => {
    if (state.name === 'presenting' && !unconfirmed && flow.how.chosen !== 'qr') flow.scanReceipt()
  }, [state.name, unconfirmed, flow])

  const check = flow.witness()
  const nearby =
    check && (state.name === 'presenting' || state.name === 'awaiting-receipt' || state.name === 'confirmed') ? (
      <NearbyCheck role="payer" messageId={state.payment.messageId} {...check} />
    ) : null

  if (state.name === 'awaiting-receipt' && flow.how.chosen !== 'qr') {
    return (
      <>
        <WaitingScreen
          medium={flow.how.chosen}
          title={t('payment:send.waiting')}
          steps={STEPS}
          onCancel={flow.cancelReceipt}
          cancelLabel={t('payment:review.cancel')}
        />
        {nearby}
      </>
    )
  }

  if (state.name === 'awaiting-receipt') {
    return (
      <ScanScreen
        hint={t('payment:scan.receiptHint')}
        hintTestID="pay-scan-receipt-hint"
        progress={flow.progress}
        onText={flow.submitText}
        onCancel={flow.cancelReceipt}
        cancelLabel={t('payment:review.cancel')}
      />
    )
  }

  if (state.name === 'presenting') {
    return (
      <Screen testID="pay-presenting" steps={STEPS}>
        <Amount value={money(state.payment.amount)} symbol={BUILD_TOKEN.symbol} />
        {flow.texts ? (
          <QrPresenter
            texts={flow.texts}
            accessibilityLabel={t('payment:send.codeLabel', {
              amount: money(state.payment.amount),
              symbol: BUILD_TOKEN.symbol,
            })}
          />
        ) : null}
        <View testID="pay-status" className="items-center gap-2" accessibilityLiveRegion="polite">
          <Chip
            kind="waiting"
            label={
              state.unconfirmed
                ? t('payment:send.unconfirmedShort')
                : state.otherReceipt
                  ? t('payment:send.otherPayment')
                  : t('payment:send.waiting')
            }
          />
        </View>
        <View className="items-center">
          <Info
            title={t('payment:send.title')}
            lines={state.unconfirmed ? [t('payment:send.unconfirmed')] : [t('payment:send.keepUp')]}
          />
        </View>
        {nearby}
        <View className="gap-3">
          {state.unconfirmed ? (
            <>
              <Button
                testID="pay-wait-again"
                variant="tonal"
                label={t('payment:send.waitAgain')}
                onPress={flow.scanReceipt}
              />
              <Button
                testID="pay-send-again"
                variant="tonal"
                label={t('payment:send.resume')}
                onPress={() => void flow.resume()}
              />
            </>
          ) : null}
          {flow.how.chosen === 'qr' ? (
            <Button
              testID="pay-scan-receipt"
              variant="tonal"
              label={t('payment:send.scanReceipt')}
              onPress={flow.scanReceipt}
            />
          ) : null}
          <Button testID="pay-done" variant="text" label={t('payment:send.done')} onPress={flow.finish} />
        </View>
      </Screen>
    )
  }

  if (state.name === 'confirmed') {
    return (
      <Screen testID="pay-result-confirmed" steps={{ total: 3, current: 3 }}>
        <Stage hero={<Hero kind="done" decorative />} title={t('payment:send.paid')} tone="success">
          <Amount value={money(state.payment.amount)} symbol={BUILD_TOKEN.symbol} />
        </Stage>
        {nearby}
        <Button testID="pay-done" variant="filled" label={t('payment:send.done')} onPress={flow.finish} />
      </Screen>
    )
  }

  if (state.name === 'rejected') {
    const issue = issueOf(state.payment)
    const lock = flow.offline.locks.find(({ lockSeq }) => lockSeq === issue?.lockSeq)
    const why = reasonText(state.reason, {
      window: MIN_WINDOW,
      max: PAY_LIMITS.maxPayment,
      symbol: BUILD_TOKEN.symbol,
      decimals: BUILD_TOKEN.decimals,
    })
    const held = t('payment:send.rejectedNext', {
      amount: money(state.payment.amount),
      symbol: BUILD_TOKEN.symbol,
      date: lock ? formatDate(lock.lockUntil, currentLanguage()) : '',
    })
    return (
      <Screen testID="pay-result-rejected" steps={STEPS}>
        <Stage hero={<Hero kind="problem" decorative />} title={t('payment:send.rejectedTitle')} line={why}>
          <View className="flex-row items-center gap-1">
            <Chip kind="info" label={t('payment:send.stillYours')} />
            <Info title={t('payment:send.rejectedTitle')} lines={[held]} />
          </View>
        </Stage>
        <View className="gap-3">
          <Button testID="pay-again" variant="filled" label={t('payment:send.again')} onPress={flow.showAgain} />
          <Button testID="pay-done" variant="text" label={t('payment:send.done')} onPress={flow.finish} />
        </View>
      </Screen>
    )
  }

  if (state.name === 'failed') {
    const key = payErrorKey(state.error, nativeErrorCode(state.error.cause))
    const resumable = key === 'Locked' || key === 'SignFailed' || key === 'SendFailed'
    return (
      <Screen testID="pay-failed" steps={STEPS}>
        <Stage
          hero={<Hero kind="problem" decorative />}
          title={t(`payment:payError.${key}`, {
            amount: money(PAY_LIMITS.biometricFrom),
            symbol: BUILD_TOKEN.symbol,
          })}
        />
        <View className="gap-3">
          {resumable ? (
            <Button
              testID="pay-resume"
              variant="filled"
              label={t('payment:send.resume')}
              onPress={() => void flow.resume(flow.unfinished.at(-1)?.messageId)}
            />
          ) : null}
          {key === 'NoKey' ? (
            <Button
              testID="pay-reset-identity"
              variant="tonal"
              label={t('payment:send.resetIdentity')}
              onPress={() => router.push('/reset-identity')}
            />
          ) : null}
          <Button testID="pay-done" variant="text" label={t('payment:send.done')} onPress={flow.finish} />
        </View>
      </Screen>
    )
  }

  return null
}
