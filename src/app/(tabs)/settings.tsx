import { router } from 'expo-router'
import { Settings } from '../../features/settings/settings'
import { MIN_WINDOW, PAY_LIMITS } from '../../features/pay/limits'
import { BUILD_TOKEN } from '../../features/pay/tokens'
import { useSettlementRunner } from '../../features/settlement/use-settlement-runner'
import { formatMoney } from '../../utils/format-amount'
import { formatDuration } from '../../utils/format-duration'

const money = (units: bigint) => `${formatMoney(units, BUILD_TOKEN.decimals)} ${BUILD_TOKEN.symbol}`

export default function SettingsTab() {
  const { unsettled } = useSettlementRunner()
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
      }}
    />
  )
}
