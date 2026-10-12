import { useTranslation } from 'react-i18next'
import { ActivityIndicator, View } from 'react-native'
import { Amount } from '../../components/amount'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Info } from '../../components/info'
import { Tile } from '../../components/tile'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { formatMoney } from '../../i18n/format'
import { useThemeColors } from '../../theme/use-theme-colors'

export type HomeSummaryProps = {
  /** What can be paid without internet; null while it loads. */
  allowance: bigint | null
  symbol: string
  decimals: number
  /** Payments received that are not credited yet. */
  settling?: number
  onPay: () => void
  onReceive: () => void
  onAddMoney: () => void
}

/** What the person has to pay with, as one big number, and the two things they come to do. */
export function HomeSummary({
  allowance,
  symbol,
  decimals,
  settling = 0,
  onPay,
  onReceive,
  onAddMoney,
}: HomeSummaryProps) {
  const { t } = useTranslation(NAMESPACES)
  const [primary] = useThemeColors('primary')
  const funded = allowance !== null && allowance > 0n
  return (
    <View testID="home-summary" className="gap-4">
      <View className="items-center gap-3 rounded-3xl border border-outline bg-surface p-6">
        <View className="w-full flex-row items-center justify-between">
          <Chip kind="info" icon="wifi_off" label={t('common:home.offline')} />
          <Info title={symbol} lines={[t('common:usdcHelp')]} />
        </View>
        {allowance === null ? (
          <View className="items-center gap-2 py-2">
            <ActivityIndicator accessibilityLabel={t('common:checking')} color={primary} />
            <AppText variant="label" tone="muted">
              {t('common:checking')}
            </AppText>
          </View>
        ) : (
          <Amount value={formatMoney(allowance, decimals, currentLanguage())} symbol={symbol} />
        )}
        {settling > 0 ? <Chip center kind="waiting" label={t('common:home.settling', { count: settling })} /> : null}
      </View>
      <View className="flex-row gap-3">
        {allowance === null || funded ? (
          <Tile testID="home-pay" highlight icon="north_east" title={t('common:tabs.pay')} onPress={onPay} />
        ) : (
          <Tile
            testID="home-add-money"
            highlight
            icon="add_circle"
            title={t('common:home.addFunds')}
            onPress={onAddMoney}
          />
        )}
        <Tile testID="home-receive" icon="south_west" title={t('common:tabs.receive')} onPress={onReceive} />
      </View>
      {funded ? (
        <Button testID="home-add-money" variant="text" label={t('common:home.addFunds')} onPress={onAddMoney} />
      ) : null}
    </View>
  )
}
