import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { formatMoney } from '../../utils/format-amount'
import { fill, nettingCopy } from './copy'

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
  const { consent } = nettingCopy
  const money = (units: bigint) => `${formatMoney(units, decimals)} ${symbol}`
  const net = `${sign(view.netBefore)}${money(view.netBefore < 0n ? -view.netBefore : view.netBefore)}`
  return (
    <Screen testID="netting-consent">
      <AppText variant="headline">{consent.title}</AppText>
      {view.tabs.map((tab, index) => (
        <View key={index} className="gap-1 py-2">
          <AppText variant="title">{tab.direction === 'owesMe' ? consent.owesMe : consent.iOwe}</AppText>
          <AppText variant="body">{`${consent.before}: ${money(tab.amount)}`}</AppText>
          <AppText variant="body">{`${consent.after}: ${money(tab.remaining)}`}</AppText>
          <AppText variant="label" tone="muted">
            {tab.due === 0
              ? consent.onDemand
              : fill(consent.due, { date: new Date(tab.due * 1000).toLocaleDateString() })}
          </AppText>
        </View>
      ))}
      <AppText variant="body">{fill(consent.net, { net })}</AppText>
      <AppText variant="label" tone="muted">
        {fill(consent.expires, { time: new Date(view.expires * 1000).toLocaleString() })}
      </AppText>
      <View className="gap-3">
        <Button testID="netting-sign" variant="filled" label={consent.sign} onPress={onSign} />
        <Button testID="netting-decline" variant="text" label={consent.decline} onPress={onDecline} />
      </View>
    </Screen>
  )
}
