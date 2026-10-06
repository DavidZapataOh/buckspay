import { router } from 'expo-router'
import { useEffect } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { PAY_LIMITS, MIN_WINDOW } from '../../features/pay/limits'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { copy, text } from '../../features/payment/copy'
import { QrPresenter } from '../../features/qr/qr-presenter'
import { ScanScreen } from '../../features/qr/scan-screen'
import { AcceptedResult, RejectedResult } from '../../features/receive/result'
import { useSecondsLeft } from '../../features/receive/use-seconds-left'
import { useReceiveFlow } from '../../features/receive/use-receive-flow'
import { useSettlementRunner } from '../../features/settlement/use-settlement-runner'
import { safetyCode } from '../../payment/messages'
import { formatMoney } from '../../utils/format-amount'
import { formatCountdown } from '../../utils/format-duration'

export default function ReceiveSession() {
  const flow = useReceiveFlow()
  const settlement = useSettlementRunner()
  const { state } = flow
  const expiresAt = state.name === 'requesting' ? state.expiresAt : undefined
  const left = useSecondsLeft(expiresAt)

  useEffect(() => {
    if (state.name === 'requesting' && left === 0) flow.expire()
  }, [state.name, left, flow])

  useEffect(() => {
    if (state.name === 'composing') router.back()
  }, [state.name])

  useEffect(() => {
    if (state.name === 'accepted') void settlement.run()
  }, [state.name, settlement])

  if (state.name === 'scanning' || state.name === 'verifying') {
    return state.name === 'scanning' ? (
      <ScanScreen
        hint={copy.receive.scanning}
        hintTestID="receive-scanning"
        progress={flow.progress}
        notice={flow.wrongCode ? copy.scan.wrongPayment : undefined}
        onText={flow.submitText}
        onCancel={flow.back}
        cancelLabel={copy.review.cancel}
      />
    ) : (
      <Screen testID="receive-verifying">
        <AppText variant="headline" accessibilityLiveRegion="polite">
          {copy.receive.checking}
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
            flow.texts ? <QrPresenter texts={flow.texts} accessibilityLabel={copy.receive.receiptLabel} /> : undefined
          }
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
        <AppText variant="headline">{copy.receive.expired}</AppText>
        <Button testID="receive-new" variant="filled" label={copy.receive.newRequest} onPress={flow.finish} />
      </Screen>
    )
  }

  if (state.name === 'requesting') {
    const { request } = state
    const amount = formatMoney(request.amount, BUILD_TOKEN.decimals)
    return (
      <Screen testID="receive-request">
        <AppText variant="headline">{copy.receive.requestTitle}</AppText>
        {flow.texts ? (
          <QrPresenter
            texts={flow.texts}
            accessibilityLabel={text(copy.receive.requestLabel, { amount, symbol: BUILD_TOKEN.symbol })}
          />
        ) : null}
        <AppText variant="title">{`${amount} ${BUILD_TOKEN.symbol}`}</AppText>
        <View testID="receive-code" accessible>
          <AppText variant="body">{text(copy.receive.code, { code: safetyCode(request.owner) })}</AppText>
          <AppText variant="label" tone="muted">
            {copy.receive.payerSeesCode}
          </AppText>
        </View>
        <AppText testID="receive-countdown" variant="body" tone="muted">
          {text(copy.receive.countdown, { time: formatCountdown(left) })}
        </AppText>
        <View className="gap-3">
          <Button
            testID="receive-scan-payment"
            variant="filled"
            label={copy.receive.scanPayment}
            onPress={flow.scanPayment}
          />
          <Button
            testID="receive-cancel"
            variant="text"
            label={copy.receive.cancelRequest}
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
