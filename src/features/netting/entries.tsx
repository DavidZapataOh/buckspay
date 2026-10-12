import { router } from 'expo-router'
import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { Pressable, View } from 'react-native'
import { AppText } from '../../components/app-text'

/** The two ways into the debts from Activity. */
export function NettingEntries() {
  const { t } = useTranslation(NAMESPACES)
  return (
    <View>
      <Pressable
        testID="debts-entry"
        accessibilityRole="button"
        accessibilityLabel={t('netting:entries.debts')}
        onPress={() => router.push('/debts')}
        className="min-h-14 justify-center py-2"
      >
        <AppText variant="body">{t('netting:entries.debts')}</AppText>
      </Pressable>
      <Pressable
        testID="netting-entry"
        accessibilityRole="button"
        accessibilityLabel={t('netting:entries.netting')}
        onPress={() => router.push('/debts/netting')}
        className="min-h-14 justify-center py-2"
      >
        <AppText variant="body">{t('netting:entries.netting')}</AppText>
      </Pressable>
    </View>
  )
}
