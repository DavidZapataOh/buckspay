import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { formatMoney } from '../../utils/format-amount'
import { text } from '../payment/copy'
import { remoteCopy } from '../remote/copy'
import type { Incoming } from './incoming'

/** What reached the wallet from far away: finalized settlements, newest first, each as the person who paid is not known by name. */
export function IncomingList({
  items,
  symbol,
  decimals,
}: {
  items: readonly Incoming[]
  symbol: string
  decimals: number
}) {
  if (items.length === 0) return null
  return (
    <View testID="incoming" className="gap-2">
      {items.map((item) => (
        <View key={item.signature} className="min-h-14 justify-center py-2">
          <AppText variant="body">
            {text(remoteCopy.received, {
              amount: formatMoney(item.amount, decimals),
              symbol,
              from: remoteCopy.fromUnknown,
            })}
          </AppText>
          <AppText variant="label" tone="muted">
            {new Date(item.at * 1000).toLocaleString()}
          </AppText>
        </View>
      ))}
    </View>
  )
}
