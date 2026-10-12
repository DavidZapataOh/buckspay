import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { Pressable, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'

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
  onReceive,
}: {
  tabs: readonly TabSummary[]
  symbol: string
  decimals: number
  onOpen: (tab: Uint8Array) => void
  onNew: () => void
  onReceive: () => void
}) {
  const { t } = useTranslation(NAMESPACES)

  return (
    <Screen testID="debts">
      <AppText variant="headline">{t('debts:title')}</AppText>
      <AppText variant="label" tone="muted">
        {t('debts:intro')}
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
                {t('debts:waiting', { peer: tab.peerLabel })}
              </AppText>
            ) : null}
            {tab.locked ? (
              <AppText variant="label" tone="muted">
                {t('debts:locked')}
              </AppText>
            ) : null}
            {tab.settling ? (
              <AppText variant="label" tone="muted">
                {tab.settlingReceived
                  ? t('debts:settlingReceived', {
                      peer: tab.peerLabel,
                      amount: money(tab.settlingAmount, decimals, symbol),
                    })
                  : t('debts:settling', { amount: money(tab.settlingAmount, decimals, symbol) })}
              </AppText>
            ) : null}
            {tab.orphaned ? (
              <AppText variant="label" tone="danger">
                {t('debts:orphaned')}
              </AppText>
            ) : null}
          </Pressable>
        )
      })}
      <View className="gap-2">
        <Button variant="filled" label={t('debts:newDebt')} onPress={onNew} />
        <Button variant="tonal" label={t('debts:receive')} onPress={onReceive} />
      </View>
    </Screen>
  )
}

const bytesKey = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
