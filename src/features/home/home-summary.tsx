import { useTranslation } from 'react-i18next'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { formatMoney } from '../../i18n/format'

export type HomeSummaryProps = {
  /** What can be paid without internet; null while it loads. */
  allowance: bigint | null
  symbol: string
  decimals: number
  onPay: () => void
  onReceive: () => void
  onAddMoney: () => void
}

/** What the person has to pay with and the two things they come to do. */
export function HomeSummary({ allowance, symbol, decimals, onPay, onReceive, onAddMoney }: HomeSummaryProps) {
  const { t } = useTranslation(NAMESPACES)
  const funded = allowance !== null && allowance > 0n
  return (
    <View testID="home-summary" className="rounded-3xl bg-surface p-5 gap-4">
      <AppText variant="headline">
        {funded
          ? t('payment:pay.allowance', { amount: formatMoney(allowance, decimals, currentLanguage()), symbol })
          : t('payment:pay.noAllowance')}
      </AppText>
      <AppText variant="label" tone="muted">
        {t('common:usdcHelp')}
      </AppText>
      <View className="gap-3">
        {funded ? (
          <>
            <Button testID="home-pay" variant="filled" label={t('common:tabs.pay')} onPress={onPay} />
            <Button testID="home-receive" variant="tonal" label={t('common:tabs.receive')} onPress={onReceive} />
            <Button testID="home-add-money" variant="text" label={t('common:home.addFunds')} onPress={onAddMoney} />
          </>
        ) : (
          <>
            <Button testID="home-add-money" variant="filled" label={t('common:home.addFunds')} onPress={onAddMoney} />
            <Button testID="home-receive" variant="tonal" label={t('common:tabs.receive')} onPress={onReceive} />
          </>
        )}
      </View>
    </View>
  )
}
