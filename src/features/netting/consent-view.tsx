import { useTranslation } from 'react-i18next'
import { View } from 'react-native'
import { Amount } from '../../components/amount'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Hero } from '../../components/hero'
import { Info } from '../../components/info'
import { Screen } from '../../components/screen'
import { Stage } from '../../components/stage'
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
  const number = (units: bigint) => formatMoney(units, decimals, currentLanguage())
  const money = (units: bigint) => `${number(units)} ${symbol}`
  const net = `${sign(view.netBefore)}${money(view.netBefore < 0n ? -view.netBefore : view.netBefore)}`
  return (
    <Screen
      testID="netting-consent"
      steps={{ total: 3, current: 1 }}
      footer={
        <View className="gap-3">
          <Button testID="netting-sign" variant="filled" label={t('netting:consent.sign')} onPress={onSign} />
          <Button testID="netting-decline" variant="text" label={t('netting:consent.decline')} onPress={onDecline} />
        </View>
      }
    >
      <Stage hero={<Hero kind="coins" decorative size={110} />} title={t('netting:consent.title')} />
      {view.tabs.map((tab, index) => (
        <View key={index} className="gap-2 rounded-3xl border border-outline bg-surface p-5">
          <AppText variant="title">
            {tab.direction === 'owesMe' ? t('netting:consent.owesMe') : t('netting:consent.iOwe')}
          </AppText>
          <View className="flex-row items-center justify-around">
            <View className="items-center">
              <AppText variant="label" tone="muted">
                {t('netting:consent.before')}
              </AppText>
              <Amount size="row" value={number(tab.amount)} symbol={symbol} />
            </View>
            <AppText variant="headline" tone="muted">
              →
            </AppText>
            <View className="items-center">
              <AppText variant="label" tone="muted">
                {t('netting:consent.after')}
              </AppText>
              <Amount size="row" value={number(tab.remaining)} symbol={symbol} tone="success" />
            </View>
          </View>
          <AppText variant="label" tone="muted">
            {tab.due === 0 ? t('netting:consent.onDemand') : t('netting:consent.due', { date: formatDate(tab.due) })}
          </AppText>
        </View>
      ))}
      <View className="flex-row flex-wrap items-center justify-center gap-2">
        <Chip center kind="info" icon="balance" label={t('netting:consent.net', { net })} />
        <Chip
          center
          kind="waiting"
          label={t('netting:consent.expires', { time: formatDateTime(view.expires, currentLanguage()) })}
        />
        <Info title={t('netting:consent.title')} lines={[t('netting:privacy.group')]} />
      </View>
    </Screen>
  )
}
