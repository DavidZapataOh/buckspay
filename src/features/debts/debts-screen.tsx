import { Pressable, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { debtsCopy } from './copy'
import { balanceLine, money, type TabSummary } from './format'

/** One line for a tab, with the notes that say what is happening to it. */
export function tabSentence(tab: TabSummary, decimals: number, symbol: string): string {
  const signed = tab.direction === 'owed' ? tab.amount : tab.direction === 'owe' ? -tab.amount : 0n
  return balanceLine(tab.peerLabel, signed, decimals, symbol)
}

/** The list of debts, one row per friend, and the way to start a new one. */
export function DebtsScreen({
  tabs,
  symbol,
  decimals,
  onOpen,
  onNew,
}: {
  tabs: readonly TabSummary[]
  symbol: string
  decimals: number
  onOpen: (tab: Uint8Array) => void
  onNew: () => void
}) {
  return (
    <Screen testID="debts">
      <AppText variant="headline">{debtsCopy.title}</AppText>
      <AppText variant="label" tone="muted">
        {debtsCopy.intro}
      </AppText>
      {tabs.map((tab) => {
        const sentence = tabSentence(tab, decimals, symbol)
        return (
          <Pressable
            key={bytesKey(tab.tab)}
            accessibilityRole="button"
            accessibilityLabel={sentence}
            onPress={() => onOpen(tab.tab)}
            className="min-h-14 justify-center py-2"
          >
            <AppText variant="body">{sentence}</AppText>
            {tab.waiting ? (
              <AppText variant="label" tone="muted">
                {debtsCopy.waiting(tab.peerLabel)}
              </AppText>
            ) : null}
            {tab.locked ? (
              <AppText variant="label" tone="muted">
                {debtsCopy.locked}
              </AppText>
            ) : null}
            {tab.settling ? (
              <AppText variant="label" tone="muted">
                {debtsCopy.settling(money(tab.settlingAmount, decimals, symbol))}
              </AppText>
            ) : null}
            {tab.orphaned ? (
              <AppText variant="label" tone="danger">
                {debtsCopy.orphaned}
              </AppText>
            ) : null}
          </Pressable>
        )
      })}
      <View className="gap-2">
        <Button variant="filled" label={debtsCopy.newDebt} onPress={onNew} />
      </View>
    </Screen>
  )
}

const bytesKey = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
