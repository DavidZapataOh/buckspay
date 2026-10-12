import { router } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { View } from 'react-native'
import { Tile } from '../../components/tile'

/** The two ways into the debts from History. */
export function NettingEntries() {
  const { t } = useTranslation(NAMESPACES)
  return (
    <View className="flex-row gap-3">
      <Tile
        compact
        testID="debts-entry"
        icon="receipt_long"
        title={t('netting:entries.debts')}
        onPress={() => router.push('/debts')}
      />
      <Tile
        compact
        testID="netting-entry"
        icon="sync"
        title={t('netting:entries.netting')}
        onPress={() => router.push('/debts/netting')}
      />
    </View>
  )
}
