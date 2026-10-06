import { router } from 'expo-router'
import { useEffect } from 'react'
import { AccessibilityInfo, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { decodeBundle } from '../../payment/messages'
import type { SentPayment } from '../../payment/pay'
import { nativeErrorCode } from '../../keys'
import { MIN_WINDOW, PAY_LIMITS } from '../../features/pay/limits'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { usePayFlow } from '../../features/pay/use-pay-flow'
import { copy, payErrorKey, text } from '../../features/payment/copy'
import { reasonText } from '../../features/payment/reason-text'
import { ResultMark } from '../../features/payment/result-mark'
import { QrPresenter } from '../../features/qr/qr-presenter'
import { ScanScreen } from '../../features/qr/scan-screen'
import { WaitingScreen } from '../../features/transport/waiting'
import { NearbyCheck } from '../../features/witness/nearby-check'
import { formatMoney } from '../../utils/format-amount'

const money = (units: bigint) => formatMoney(units, BUILD_TOKEN.decimals)

function issueOf(payment: SentPayment) {
  try {
    return decodeBundle(payment.bundle).issue.message
  } catch {
    return undefined
  }
}

export default function PaySend() {
  const flow = usePayFlow()
  const { state } = flow

  useEffect(() => {
    if (state.name === 'idle') router.back()
  }, [state.name])

  useEffect(() => {
    if (state.name === 'confirmed') {
      const issue = issueOf(state.payment)
      AccessibilityInfo.announceForAccessibility(
        text(copy.send.confirmedSpoken, { amount: issue ? money(issue.amount) : '', symbol: BUILD_TOKEN.symbol }),
      )
    }
  }, [state])

  useEffect(() => {
    if (state.name === 'presenting' && flow.how.chosen !== 'qr') flow.scanReceipt()
  }, [state.name, flow])

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
          title={copy.send.waiting}
          onCancel={flow.cancelReceipt}
          cancelLabel={copy.review.cancel}
        />
        {nearby}
      </>
    )
  }

  if (state.name === 'awaiting-receipt') {
    return (
      <ScanScreen
        hint={copy.scan.receiptHint}
        hintTestID="pay-scan-receipt-hint"
        progress={flow.progress}
        onText={flow.submitText}
        onCancel={flow.cancelReceipt}
        cancelLabel={copy.review.cancel}
      />
    )
  }

  if (state.name === 'presenting') {
    const issue = issueOf(state.payment)
    return (
      <Screen testID="pay-presenting">
        <AppText variant="headline">{copy.send.title}</AppText>
        {flow.texts ? (
          <QrPresenter
            texts={flow.texts}
            accessibilityLabel={text(copy.send.codeLabel, {
              amount: issue ? money(issue.amount) : '',
              symbol: BUILD_TOKEN.symbol,
            })}
          />
        ) : null}
        <AppText testID="pay-status" variant="body" accessibilityLiveRegion="polite">
          {state.otherReceipt ? copy.send.otherPayment : copy.send.waiting}
        </AppText>
        <AppText variant="body" tone="muted">
          {copy.send.keepUp}
        </AppText>
        {nearby}
        <View className="gap-3">
          {flow.how.chosen === 'qr' ? (
            <Button
              testID="pay-scan-receipt"
              variant="tonal"
              label={copy.send.scanReceipt}
              onPress={flow.scanReceipt}
            />
          ) : null}
          <Button testID="pay-done" variant="text" label={copy.send.done} onPress={flow.finish} />
        </View>
      </Screen>
    )
  }

  if (state.name === 'confirmed') {
    const issue = issueOf(state.payment)
    return (
      <Screen testID="pay-result-confirmed">
        <ResultMark ok />
        <AppText variant="headline" tone="success">
          {text(copy.send.confirmed, { amount: issue ? money(issue.amount) : '', symbol: BUILD_TOKEN.symbol })}
        </AppText>
        {nearby}
        <Button testID="pay-done" variant="filled" label={copy.send.done} onPress={flow.finish} />
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
    return (
      <Screen testID="pay-result-rejected">
        <ResultMark ok={false} />
        <AppText variant="headline" tone="danger">
          {text(copy.send.rejected, { reason: why.replace(/\.$/, '') })}
        </AppText>
        <AppText variant="body">
          {text(copy.send.rejectedNext, {
            amount: issue ? money(issue.amount) : '',
            symbol: BUILD_TOKEN.symbol,
            date: lock ? new Date(lock.lockUntil * 1000).toLocaleDateString() : '',
          })}
        </AppText>
        <View className="gap-3">
          <Button testID="pay-again" variant="filled" label={copy.send.again} onPress={flow.showAgain} />
          <Button testID="pay-done" variant="text" label={copy.send.done} onPress={flow.finish} />
        </View>
      </Screen>
    )
  }

  if (state.name === 'failed') {
    const key = payErrorKey(state.error, nativeErrorCode(state.error.cause))
    const resumable = key === 'Locked' || key === 'SignFailed' || key === 'SendFailed'
    return (
      <Screen testID="pay-failed">
        <ResultMark ok={false} />
        <AppText variant="headline" tone="danger" accessibilityLiveRegion="polite">
          {text(copy.payError[key], {
            amount: money(PAY_LIMITS.biometricFrom),
            symbol: BUILD_TOKEN.symbol,
          })}
        </AppText>
        <View className="gap-3">
          {resumable ? (
            <Button
              testID="pay-resume"
              variant="filled"
              label={copy.send.resume}
              onPress={() => void flow.resume(flow.unfinished.at(-1)?.messageId)}
            />
          ) : null}
          {key === 'NoKey' ? (
            <Button
              testID="pay-reset-identity"
              variant="tonal"
              label={copy.send.resetIdentity}
              onPress={() => router.push('/reset-identity')}
            />
          ) : null}
          <Button testID="pay-done" variant="text" label={copy.send.done} onPress={flow.finish} />
        </View>
      </Screen>
    )
  }

  return null
}
