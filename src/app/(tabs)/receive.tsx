import { formatDuration, formatMoney, parseAmount } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
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
import { useSettlementMinimum } from '../../features/settlement/use-settlement-minimum'

import { HowControl } from '../../features/transport/how-control'

import { useReceiveFlow } from '../../features/receive/use-receive-flow'

const MAX_MEMO_BYTES = 48

export default function Receive() {
  const { t } = useTranslation(NAMESPACES)

  const { step } = useDeviceIdentity()
  const flow = useReceiveFlow()
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const [passOn, setPassOn] = useState(false)
  const [error, setError] = useState<string>()
  const minimum = useSettlementMinimum()
  const units = parseAmount(amount, BUILD_TOKEN.decimals)
  const valid = units !== undefined && units > 0n && units <= PAY_LIMITS.maxPayment
  const max = `${formatMoney(PAY_LIMITS.maxPayment, BUILD_TOKEN.decimals, currentLanguage())} ${BUILD_TOKEN.symbol}`
  const bytes = new TextEncoder().encode(memo).length

  async function create() {
    const failure = await flow.create(amount, memo, passOn)
    if (failure === 'amount') setError(t('payment:receive.invalidAmount', { max }))
    else if (failure === 'connect') setError(t('payment:receive.connectOnce'))
    else if (failure === 'transport')
      setError(t('payment:receive.transportFailed', { medium: t(`transport:labels.${flow.how.chosen}`) }))
    else if (failure === 'busy') return
    else {
      setError(undefined)
      router.push('/receive/session')
    }
  }

  return (
    <Screen testID="receive">
      <AppText variant="headline">{t('payment:receive.title')}</AppText>
      <HowControl
        offered={flow.how.offered}
        chosen={flow.how.chosen}
        onChoose={flow.how.choose}
        onRecheck={flow.how.refresh}
      />
      {step !== 'ready' ? (
        <View className="gap-4">
          <AppText variant="body">{t('payment:receive.setup')}</AppText>
          <Button
            testID="setup-payments"
            variant="filled"
            label={t('payment:pay.setupAction')}
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
            label={`${t('payment:receive.amount')} (${BUILD_TOKEN.symbol})`}
            keyboardType="decimal-pad"
            value={amount}
            onChangeText={setAmount}
          />
          <TextField testID="receive-memo" label={t('payment:receive.memo')} value={memo} onChangeText={setMemo} />
          <View className="min-h-14 flex-row items-center justify-between gap-4">
            <AppText variant="body">{t('payment:receive.passOn')}</AppText>
            <Switch
              testID="receive-pass-on"
              accessibilityLabel={t('payment:receive.passOn')}
              value={passOn}
              onValueChange={setPassOn}
            />
          </View>
          <AppText variant="label" tone={bytes > MAX_MEMO_BYTES ? 'danger' : 'muted'}>
            {t('payment:receive.memoCount', { count: bytes })}
          </AppText>
          <AppText testID="receive-limits" variant="body" tone="muted">
            {t('payment:receive.limits', { max, window: formatDuration(MIN_WINDOW) })}
          </AppText>
          <AppText variant="label" tone="muted">
            {t('payment:receive.bondLimit')}
          </AppText>
          {minimum !== undefined ? (
            <AppText testID="receive-minimum" variant="label" tone="muted">
              {t('payment:receive.minimum', {
                amount: `${formatMoney(minimum, BUILD_TOKEN.decimals, currentLanguage())} ${BUILD_TOKEN.symbol}`,
              })}
            </AppText>
          ) : null}
          {minimum !== undefined && units !== undefined && units > 0n && units < minimum ? (
            <AppText testID="receive-below-minimum" variant="label">
              {t('payment:receive.belowMinimum')}
            </AppText>
          ) : null}
          <StatusNote tone="danger" message={error} />
          <Button
            testID="receive-create"
            variant="filled"
            label={t('payment:receive.create')}
            disabled={!valid}
            onPress={() => void create()}
          />
          <Button
            testID="receive-point"
            variant="text"
            label={t('event:pointTitle')}
            onPress={() => router.push('/receive/point')}
          />
          <Button
            testID="receive-far-away"
            variant="text"
            label={t('remote:receiveTitle')}
            onPress={() => router.push('/receive/far-away')}
          />
        </>
      )}
    </Screen>
  )
}
