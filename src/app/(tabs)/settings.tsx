import { router } from 'expo-router'
import { useState } from 'react'
import { Settings } from '../../features/settings/settings'
import { MIN_WINDOW, PAY_LIMITS } from '../../features/pay/limits'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { useSettlementRunner } from '../../features/settlement/use-settlement-runner'
import { usePayments } from '../../features/payment/payments-provider'
import { formatMoney, parseAmount } from '../../utils/format-amount'
import { formatDuration } from '../../utils/format-duration'

const money = (units: bigint) => `${formatMoney(units, BUILD_TOKEN.decimals)} ${BUILD_TOKEN.symbol}`

export default function SettingsTab() {
  const { unsettled } = useSettlementRunner()
  const { witnessSettings, setWitnessSettings } = usePayments()
  const [requireFrom, setRequireFrom] = useState(
    witnessSettings.requireFrom === null ? '' : formatMoney(witnessSettings.requireFrom, BUILD_TOKEN.decimals),
  )
  return (
    <Settings
      payments={{
        unsettled: unsettled?.count ?? 0,
        limits: {
          perPayment: money(PAY_LIMITS.maxPayment),
          biometricFrom: money(PAY_LIMITS.biometricFrom),
          biometricDaily: money(PAY_LIMITS.biometricDaily),
          window: formatDuration(MIN_WINDOW),
        },
        onReset: () => router.push('/reset-identity'),
        onEvents: () => router.push('/events'),
        nearbyCheck: {
          answer: witnessSettings.answer,
          ask: witnessSettings.ask,
          audible: witnessSettings.audible,
          requireFrom,
          onAnswer: (answer) => setWitnessSettings({ answer }),
          onAsk: (ask) => setWitnessSettings({ ask }),
          onAudible: (audible) => setWitnessSettings({ audible }),
          onRequireFrom: (value) => {
            setRequireFrom(value)
            const amount = parseAmount(value, BUILD_TOKEN.decimals)
            if (value.trim() === '') setWitnessSettings({ requireFrom: null })
            else if (amount !== undefined && amount > 0n) setWitnessSettings({ requireFrom: amount })
          },
        },
      }}
    />
  )
}
