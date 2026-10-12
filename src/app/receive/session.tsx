import { formatCountdown, formatMoney } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { router } from 'expo-router'
import { useEffect, useRef } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { PAY_LIMITS, MIN_WINDOW } from '../../features/pay/limits'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { QrPresenter } from '../../features/qr/qr-presenter'
import { ScanScreen } from '../../features/qr/scan-screen'
import { WaitingScreen } from '../../features/transport/waiting'
import { NearbyCheck } from '../../features/witness/nearby-check'

import { AcceptedResult, RejectedResult } from '../../features/receive/result'
import { useSecondsLeft } from '../../features/receive/use-seconds-left'
import { pointReasonText } from '../../features/event/copy'
import { usePointMode } from '../../features/event/use-point-mode'
import { useReceiveFlow } from '../../features/receive/use-receive-flow'
import { useSettlementRunner } from '../../features/settlement/use-settlement-runner'
import { safetyCode } from '../../payment/messages'

export default function ReceiveSession() {
  const { t } = useTranslation(NAMESPACES)

  const flow = useReceiveFlow()
  const { mode: point } = usePointMode()
  const settlement = useSettlementRunner()
  const { state } = flow
  const expiresAt = state.name === 'requesting' || state.name === 'scanning' ? state.expiresAt : undefined
  const left = useSecondsLeft(expiresAt)

  useEffect(() => {
    if (state.name === 'requesting' && left === 0) flow.expire()
  }, [state.name, left, flow])

  const latest = useRef(flow)
  useEffect(() => {
    latest.current = flow
  })
  useEffect(
    () => () => {
      const { state: left, cancel, finish } = latest.current
      if (left.name === 'requesting') cancel()
      else if (left.name === 'expired' || left.name === 'rejected') finish()
    },
    [],
  )

  useEffect(() => {
    if (state.name === 'composing') router.back()
  }, [state.name])

  useEffect(() => {
    if (state.name === 'accepted') void settlement.run()
  }, [state.name, settlement])

  if (state.name === 'scanning' || state.name === 'verifying') {
    return state.name === 'scanning' && flow.how.chosen !== 'qr' ? (
      <WaitingScreen
        medium={flow.how.chosen}
        title={t('payment:receive.waitingForPayment')}
        notice={flow.wrongCode ? t('payment:scan.wrongPayment') : undefined}
        detail={t('payment:receive.countdown', { time: formatCountdown(left) })}
        onCancel={flow.back}
        cancelLabel={t('payment:review.cancel')}
      />
    ) : state.name === 'scanning' ? (
      <ScanScreen
        hint={t('payment:receive.scanning')}
        hintTestID="receive-scanning"
        progress={flow.progress}
        notice={flow.wrongCode ? t('payment:scan.wrongPayment') : undefined}
        onText={flow.submitText}
        onCancel={flow.back}
        cancelLabel={t('payment:review.cancel')}
      />
    ) : (
      <Screen testID="receive-verifying">
        <AppText variant="headline" accessibilityLiveRegion="polite">
          {t('payment:receive.checking')}
        </AppText>
      </Screen>
    )
  }

  if (state.name === 'accepted') {
    return (
      <Screen testID="receive-accepted">
        <AcceptedResult
          outcome={state.outcome}
          symbol={BUILD_TOKEN.symbol}
          decimals={BUILD_TOKEN.decimals}
          receipt={
            flow.texts ? (
              <QrPresenter texts={flow.texts} accessibilityLabel={t('payment:receive.receiptLabel')} />
            ) : undefined
          }
          witness={(() => {
            const check = flow.witness()
            return check && state.outcome.accepted ? (
              <NearbyCheck role="receiver" messageId={state.outcome.messageId} {...check} />
            ) : undefined
          })()}
          onDone={flow.finish}
        />
      </Screen>
    )
  }

  if (state.name === 'rejected') {
    return (
      <Screen testID="receive-rejected">
        <RejectedResult
          reason={state.reason}
          why={point ? (pointReasonText(state.reason) ?? undefined) : undefined}
          limits={{
            window: MIN_WINDOW,
            max: PAY_LIMITS.maxPayment,
            symbol: BUILD_TOKEN.symbol,
            decimals: BUILD_TOKEN.decimals,
          }}
          onRetry={flow.scanPayment}
          onDone={flow.finish}
        />
      </Screen>
    )
  }

  if (state.name === 'expired') {
    return (
      <Screen testID="receive-expired">
        <AppText variant="headline">{t('payment:receive.expired')}</AppText>
        <Button testID="receive-new" variant="filled" label={t('payment:receive.newRequest')} onPress={flow.finish} />
      </Screen>
    )
  }

  if (state.name === 'requesting') {
    const { request } = state
    const amount = formatMoney(request.amount, BUILD_TOKEN.decimals, currentLanguage())
    return (
      <Screen testID="receive-request">
        <AppText variant="headline">{t(`payment:receive.requestTitle.${flow.how.chosen}`)}</AppText>
        {flow.texts ? (
          <QrPresenter
            texts={flow.texts}
            accessibilityLabel={t('payment:receive.requestLabel', { amount, symbol: BUILD_TOKEN.symbol })}
          />
        ) : null}
        <AppText variant="title">{`${amount} ${BUILD_TOKEN.symbol}`}</AppText>
        {request.witness !== 'none' ? (
          <AppText variant="label" tone="muted">
            {`${t('witness:willAsk')} ${request.witness === 'audible' ? t('witness:soundAudible') : t('witness:soundUltrasound')}`}
          </AppText>
        ) : null}
        <View testID="receive-code" accessible>
          <AppText variant="body">{t('payment:receive.code', { code: safetyCode(request.owner) })}</AppText>
          <AppText variant="label" tone="muted">
            {t('payment:receive.payerSeesCode')}
          </AppText>
        </View>
        <AppText testID="receive-countdown" variant="body" tone="muted">
          {t('payment:receive.countdown', { time: formatCountdown(left) })}
        </AppText>
        <View className="gap-3">
          {flow.how.chosen === 'qr' ? (
            <Button
              testID="receive-scan-payment"
              variant="filled"
              label={t('payment:receive.scanPayment')}
              onPress={flow.scanPayment}
            />
          ) : null}
          <Button
            testID="receive-cancel"
            variant="text"
            label={t('payment:receive.cancelRequest')}
            onPress={() => {
              flow.cancel()
            }}
          />
        </View>
      </Screen>
    )
  }
  return null
}
