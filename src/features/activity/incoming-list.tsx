import { formatDateTime, formatMoney } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'

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
  const { t } = useTranslation(NAMESPACES)

  if (items.length === 0) return null
  return (
    <View testID="incoming" className="gap-2">
      {items.map((item) => (
        <View key={item.signature} className="min-h-14 justify-center py-2">
          <AppText variant="body">
            {t('remote:received', {
              amount: formatMoney(item.amount, decimals, currentLanguage()),
              symbol,
              from: t('remote:fromUnknown'),
            })}
          </AppText>
          <AppText variant="label" tone="muted">
            {formatDateTime(item.at, currentLanguage())}
          </AppText>
        </View>
      ))}
    </View>
  )
}
