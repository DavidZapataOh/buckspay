import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { StatusNote } from '../../components/status-note'
import { TextField } from '../../components/text-field'
import { eventCopy } from '../../features/event/copy'
import { decodePairing } from '../../features/event/payloads'
import { PointStatus } from '../../features/event/point-status'
import { usePointMode } from '../../features/event/use-point-mode'
import { PAY_LIMITS } from '../../features/pay/limits'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { copy, text } from '../../features/payment/copy'
import { nowSeconds } from '../../features/payment/payments-provider'
import { useQrSession } from '../../features/payment/use-qr-session'
import { ScanScreen } from '../../features/qr/scan-screen'
import { howCopy } from '../../features/transport/copy'
import { useReceiveFlow } from '../../features/receive/use-receive-flow'
import { MessageKind } from '../../transport/types'
import { formatMoney, parseAmount } from '../../utils/format-amount'

export default function Point() {
  const { mode, status, enter, leave, link } = usePointMode()
  const flow = useReceiveFlow()
  const session = useQrSession()
  const [notPairing, setNotPairing] = useState(false)
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string>()
  const [now, setNow] = useState(nowSeconds())

  useEffect(() => {
    const timer = setInterval(() => setNow(nowSeconds()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (mode) return
    const controller = new AbortController()
    void session.transport.receive({ accept: [MessageKind.PointPairing], signal: controller.signal }).then(
      async (message) => {
        try {
          await enter(decodePairing(message.payload))
        } catch {
          setNotPairing(true)
        }
      },
      () => undefined,
    )
    return () => controller.abort()
  }, [mode, enter, session.transport])

  if (!mode) {
    return (
      <ScanScreen
        hint={eventCopy.scanPairing}
        hintTestID="point-scanning"
        progress={session.progress}
        notice={notPairing ? eventCopy.notPairing : undefined}
        onText={session.push}
        onCancel={() => router.back()}
        cancelLabel={copy.review.cancel}
      />
    )
  }

  const units = parseAmount(amount, BUILD_TOKEN.decimals)
  const valid = units !== undefined && units > 0n && units <= PAY_LIMITS.maxPayment

  async function take() {
    const failure = await flow.create(amount, '', false)
    if (failure === 'amount') {
      const max = `${formatMoney(PAY_LIMITS.maxPayment, BUILD_TOKEN.decimals)} ${BUILD_TOKEN.symbol}`
      setError(text(copy.receive.invalidAmount, { max }))
    } else if (failure === 'connect') setError(copy.receive.connectOnce)
    else if (failure === 'transport')
      setError(text(copy.receive.transportFailed, { medium: howCopy.labels[flow.how.chosen] }))
    else if (failure === 'busy') return
    else {
      setError(undefined)
      router.push('/receive/session')
    }
  }

  return (
    <Screen testID="point">
      <AppText variant="headline">{eventCopy.pointTitle}</AppText>
      <AppText variant="body">{text(eventCopy.pointFor, { event: mode.pairing.name })}</AppText>
      <PointStatus status={status} now={now} />
      <View className="gap-3">
        <Button
          testID="point-link-host"
          variant="tonal"
          label={eventCopy.linkHost}
          onPress={() => void link('receiver')}
        />
        <Button
          testID="point-link-find"
          variant="tonal"
          label={eventCopy.linkFind}
          onPress={() => void link('payer')}
        />
      </View>
      <TextField
        testID="point-amount"
        label={`${eventCopy.amount} (${BUILD_TOKEN.symbol})`}
        keyboardType="decimal-pad"
        value={amount}
        onChangeText={setAmount}
      />
      <StatusNote tone="danger" message={error} />
      <Button
        testID="point-take"
        variant="filled"
        label={eventCopy.take}
        disabled={!valid}
        onPress={() => void take()}
      />
      <Button
        testID="point-leave"
        variant="text"
        label={eventCopy.leave}
        onPress={() => void leave().then(() => router.back())}
      />
    </Screen>
  )
}
