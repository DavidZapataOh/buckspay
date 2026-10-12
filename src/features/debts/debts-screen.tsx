import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { Pressable, View } from 'react-native'
import { Amount } from '../../components/amount'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Hero } from '../../components/hero'
import { Icon } from '../../components/icon'
import { Info } from '../../components/info'
import { Screen } from '../../components/screen'
import { useThemeColors } from '../../theme/use-theme-colors'

import { balanceLine, money, type TabSummary } from './format'

/** One line for a tab, with the notes that say what is happening to it. */
export function tabSentence(tab: TabSummary, decimals: number, symbol: string): string {
  const signed = tab.direction === 'owed' ? tab.amount : tab.direction === 'owe' ? -tab.amount : 0n
  return balanceLine(tab.peerLabel, signed, decimals, symbol)
}

/** The number of a tab: what the friend owes (+) or what is owed to the friend (−), the digits only. */
export const tabNumber = (tab: TabSummary, decimals: number, symbol: string) =>
  money(tab.amount, decimals, symbol).replace(` ${symbol}`, '')

/** The list of debts, one card per friend, and the way to start a new one. */
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
  const [onContainer] = useThemeColors('on-secondary-container')

  return (
    <Screen
      testID="debts"
      footer={
        <View className="gap-2">
          <Button variant="filled" label={t('debts:newDebt')} onPress={onNew} />
          <Button variant="tonal" label={t('debts:receive')} onPress={onReceive} />
        </View>
      }
    >
      <View className="flex-row items-center justify-between">
        <AppText variant="headline">{t('debts:title')}</AppText>
        <Info title={t('debts:title')} lines={[t('debts:intro')]} />
      </View>
      {tabs.length === 0 ? (
        <View className="items-center gap-3 pt-6">
          <Hero kind="coins" decorative />
          <AppText variant="title" tone="muted">
            {t('debts:none')}
          </AppText>
        </View>
      ) : null}
      {tabs.map((tab) => {
        const sentence = tabSentence(tab, decimals, symbol)
        return (
          <Pressable
            key={bytesKey(tab.tab)}
            accessibilityRole="button"
            accessibilityLabel={sentence}
            onPress={() => onOpen(tab.tab)}
            className="min-h-20 flex-row items-center gap-3 rounded-3xl border border-outline bg-surface p-4 active:bg-secondary-container"
          >
            <View className="size-12 items-center justify-center rounded-full bg-secondary-container">
              <Icon name="person" color={onContainer} />
            </View>
            <View className="flex-1 gap-1">
              <AppText variant="title">{tab.peerLabel}</AppText>
              {tab.orphaned ? <Chip kind="problem" label={t('debts:orphaned')} /> : null}
              {tab.waiting ? <Chip kind="waiting" label={t('debts:waitingShort')} /> : null}
              {tab.locked ? <Chip kind="waiting" label={t('debts:lockedShort')} /> : null}
              {tab.settling ? (
                <Chip
                  kind="waiting"
                  label={
                    tab.settlingReceived
                      ? t('debts:settlingReceivedShort', { amount: money(tab.settlingAmount, decimals, symbol) })
                      : t('debts:settlingShort', { amount: money(tab.settlingAmount, decimals, symbol) })
                  }
                />
              ) : null}
              {tab.direction === 'settled' && !tab.waiting && !tab.settling ? (
                <Chip kind="done" label={t('debts:evenShort')} />
              ) : null}
            </View>
            {tab.direction !== 'settled' ? (
              <Amount
                size="row"
                value={`${tab.direction === 'owed' ? '+' : '−'}${tabNumber(tab, decimals, symbol)}`}
                symbol={symbol}
                tone={tab.direction === 'owed' ? 'success' : 'strong'}
              />
            ) : null}
          </Pressable>
        )
      })}
    </Screen>
  )
}

const bytesKey = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
