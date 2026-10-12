import { useTranslation } from 'react-i18next'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { formatDateTime, formatMoney } from '../../i18n/format'
import { formatDate } from '../debts/format'

type ConsentTab = {
  direction: 'owesMe' | 'iOwe'
  amount: bigint
  remaining: bigint
  due: number
}
type ConsentData = { tabs: readonly ConsentTab[]; netBefore: bigint; expires: number }

const sign = (value: bigint) => (value > 0n ? '+' : value < 0n ? '-' : '')

/** Only this phone's own tabs and its unchanged balance; nothing about anyone else's debts. */
export function ConsentView({
  view,
  symbol,
  decimals,
  onSign,
  onDecline,
}: {
  view: ConsentData
  symbol: string
  decimals: number
  onSign: () => void
  onDecline: () => void
}) {
  const { t } = useTranslation(NAMESPACES)
  const money = (units: bigint) => `${formatMoney(units, decimals, currentLanguage())} ${symbol}`
  const net = `${sign(view.netBefore)}${money(view.netBefore < 0n ? -view.netBefore : view.netBefore)}`
  return (
    <Screen testID="netting-consent">
      <AppText variant="headline">{t('netting:consent.title')}</AppText>
      {view.tabs.map((tab, index) => (
        <View key={index} className="gap-1 py-2">
          <AppText variant="title">
            {tab.direction === 'owesMe' ? t('netting:consent.owesMe') : t('netting:consent.iOwe')}
          </AppText>
          <AppText variant="body">{`${t('netting:consent.before')}: ${money(tab.amount)}`}</AppText>
          <AppText variant="body">{`${t('netting:consent.after')}: ${money(tab.remaining)}`}</AppText>
          <AppText variant="label" tone="muted">
            {tab.due === 0 ? t('netting:consent.onDemand') : t('netting:consent.due', { date: formatDate(tab.due) })}
          </AppText>
        </View>
      ))}
      <AppText variant="body">{t('netting:consent.net', { net })}</AppText>
      <AppText variant="label" tone="muted">
        {t('netting:consent.expires', { time: formatDateTime(view.expires, currentLanguage()) })}
      </AppText>
      <View className="gap-3">
        <Button testID="netting-sign" variant="filled" label={t('netting:consent.sign')} onPress={onSign} />
        <Button testID="netting-decline" variant="text" label={t('netting:consent.decline')} onPress={onDecline} />
      </View>
    </Screen>
  )
}
