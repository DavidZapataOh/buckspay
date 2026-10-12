import { formatDuration, formatMoney, parseAmount } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { router } from 'expo-router'
import { useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { useDeviceIdentity } from '../../features/identity/use-device-identity'
import { MIN_WINDOW, PAY_LIMITS } from '../../features/pay/limits'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { useSettlementMinimum } from '../../features/settlement/use-settlement-minimum'

import { HowControl } from '../../features/transport/how-control'

import { ReceiveForm } from '../../features/receive/receive-form'
import { useReceiveFlow } from '../../features/receive/use-receive-flow'
import { clampBytes } from '../../utils/clamp-bytes'

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
  const belowMinimum = minimum !== undefined && units !== undefined && units > 0n && units < minimum

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
    <Screen testID="receive" steps={{ total: 3, current: 0 }}>
      <HowControl
        role="receive"
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
          <ReceiveForm
            amount={amount}
            onAmountChange={setAmount}
            memo={memo}
            onMemoChange={(text) => setMemo(clampBytes(text, MAX_MEMO_BYTES))}
            passOn={passOn}
            onPassOnChange={setPassOn}
            amountValid={valid}
            belowMinimum={belowMinimum}
            error={error}
            onShow={() => void create()}
            minimumText={
              minimum === undefined
                ? undefined
                : `${formatMoney(minimum, BUILD_TOKEN.decimals, currentLanguage())} ${BUILD_TOKEN.symbol}`
            }
            symbol={BUILD_TOKEN.symbol}
            maxText={max}
            windowText={formatDuration(MIN_WINDOW)}
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
