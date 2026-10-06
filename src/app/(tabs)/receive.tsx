import { router } from 'expo-router'
import { useState } from 'react'
import { Switch, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { StatusNote } from '../../components/status-note'
import { TextField } from '../../components/text-field'
import { useDeviceIdentity } from '../../features/identity/use-device-identity'
import { MIN_WINDOW, PAY_LIMITS } from '../../features/pay/limits'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { copy, text } from '../../features/payment/copy'
import { eventCopy } from '../../features/event/copy'
import { useReceiveFlow } from '../../features/receive/use-receive-flow'
import { formatMoney, parseAmount } from '../../utils/format-amount'
import { formatDuration } from '../../utils/format-duration'

const MAX_MEMO_BYTES = 48

export default function Receive() {
  const { step } = useDeviceIdentity()
  const flow = useReceiveFlow()
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [passOn, setPassOn] = useState(false)
  const [error, setError] = useState<string>()
  const units = parseAmount(amount, BUILD_TOKEN.decimals)
  const valid = units !== undefined && units > 0n && units <= PAY_LIMITS.maxPayment
  const max = `${formatMoney(PAY_LIMITS.maxPayment, BUILD_TOKEN.decimals)} ${BUILD_TOKEN.symbol}`
  const bytes = new TextEncoder().encode(memo).length

  function create() {
    const failure = flow.create(amount, memo, passOn)
    if (failure === 'amount') setError(text(copy.receive.invalidAmount, { max }))
    else if (failure === 'connect') setError(copy.receive.connectOnce)
    else {
      setError(undefined)
      router.push('/receive/session')
    }
  }

  return (
    <Screen testID="receive">
      <AppText variant="headline">{copy.receive.title}</AppText>
      {step !== 'ready' ? (
        <View className="gap-4">
          <AppText variant="body">{copy.receive.setup}</AppText>
          <Button
            testID="setup-payments"
            variant="filled"
            label={copy.pay.setupAction}
            onPress={() => router.push('/onboarding')}
          />
        </View>
      ) : flow.blocked ? (
        <AppText testID="receive-blocked" variant="body">
          {flow.blocked}
        </AppText>
      ) : (
        <>
          <TextField
            testID="receive-amount"
            label={`${copy.receive.amount} (${BUILD_TOKEN.symbol})`}
            keyboardType="decimal-pad"
            value={amount}
            onChangeText={setAmount}
          />
          <TextField testID="receive-memo" label={copy.receive.memo} value={memo} onChangeText={setMemo} />
          <View className="min-h-14 flex-row items-center justify-between gap-4">
            <AppText variant="body">{copy.receive.passOn}</AppText>
            <Switch
              testID="receive-pass-on"
              accessibilityLabel={copy.receive.passOn}
              value={passOn}
              onValueChange={setPassOn}
            />
          </View>
          <AppText variant="label" tone={bytes > MAX_MEMO_BYTES ? 'danger' : 'muted'}>
            {text(copy.receive.memoCount, { count: bytes })}
          </AppText>
          <AppText testID="receive-limits" variant="body" tone="muted">
            {text(copy.receive.limits, { max, window: formatDuration(MIN_WINDOW) })}
          </AppText>
          <AppText variant="label" tone="muted">
            {copy.receive.bondLimit}
          </AppText>
          <StatusNote tone="danger" message={error} />
          <Button
            testID="receive-create"
            variant="filled"
            label={copy.receive.create}
            disabled={!valid}
            onPress={create}
          />
          <Button
            testID="receive-point"
            variant="text"
            label={eventCopy.pointTitle}
            onPress={() => router.push('/receive/point')}
          />
        </>
      )}
    </Screen>
  )
}
