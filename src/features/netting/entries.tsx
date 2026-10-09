import { router } from 'expo-router'
import { Pressable, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { nettingCopy } from './copy'

/** The two ways into the debts from Activity. */
export function NettingEntries() {
  const { entries } = nettingCopy
  return (
    <View>
      <Pressable
        testID="debts-entry"
        accessibilityRole="button"
        accessibilityLabel={entries.debts}
        onPress={() => router.push('/debts')}
        className="min-h-14 justify-center py-2"
      >
        <AppText variant="body">{entries.debts}</AppText>
      </Pressable>
      <Pressable
        testID="netting-entry"
        accessibilityRole="button"
        accessibilityLabel={entries.netting}
        onPress={() => router.push('/debts/netting')}
        className="min-h-14 justify-center py-2"
      >
        <AppText variant="body">{entries.netting}</AppText>
      </Pressable>
    </View>
  )
}
