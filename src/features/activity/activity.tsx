import { useTranslation } from 'react-i18next'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { formatDate, formatMoney } from '../../i18n/format'
import type { ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { Amount } from '../../components/amount'
import { AppText } from '../../components/app-text'
import { Chip } from '../../components/chip'
import { Hero } from '../../components/hero'
import { Icon } from '../../components/icon'
import { Screen } from '../../components/screen'
import { useThemeColors } from '../../theme/use-theme-colors'
import { NettingEntries } from '../netting/entries'
import type { ActivityRow } from '../notes/activity'
import { activityId, sentence, statusKind, statusWord } from './format'

const dayStart = (seconds: number) => new Date(seconds * 1000).setHours(0, 0, 0, 0)

/** One list of what was paid and received, newest first, under the day it happened. */
export function ActivityList({
  rows,
  symbol,
  decimals,
  now,
  onOpen,
  header,
  rewards,
}: {
  rows: readonly ActivityRow[]
  symbol: string
  decimals: number
  now: number
  onOpen: (id: string) => void
  /** What goes above the list: a notice that needs the person's attention. */
  header?: ReactNode
  /** The way into the relayer rewards, given only when this phone has some. */
  rewards?: { summary: string; onOpen: () => void }
}) {
  const { t } = useTranslation(NAMESPACES)
  const [onContainer] = useThemeColors('on-secondary-container')

  const today = dayStart(now)
  const headings = rows.map((row, index) => {
    const start = dayStart(row.at)
    if (index > 0 && dayStart(rows[index - 1].at) === start) return undefined
    return start === today ? t('payment:activity.today') : formatDate(start / 1000, currentLanguage())
  })
  return (
    <Screen testID="activity">
      <NettingEntries />
      {rewards ? (
        <Pressable
          testID="rewards-entry"
          accessibilityRole="button"
          accessibilityLabel={`${t('rewards:entry')}: ${rewards.summary}`}
          onPress={rewards.onOpen}
          className="min-h-14 justify-center py-2"
        >
          <AppText variant="body">{t('rewards:entry')}</AppText>
          <AppText variant="label" tone="muted">
            {rewards.summary}
          </AppText>
        </Pressable>
      ) : null}
      {header}
      {rows.length === 0 ? (
        <View className="items-center gap-4 pt-8">
          <Hero kind="nearby" decorative />
          <AppText variant="title" tone="muted">
            {t('payment:activity.empty')}
          </AppText>
        </View>
      ) : null}
      {rows.map((row, index) => {
        const heading = headings[index]
        const paid = row.kind === 'paid'
        const money = formatMoney(row.amount, decimals, currentLanguage())
        return (
          <View key={activityId(row)} className="gap-2">
            {heading ? (
              <AppText variant="label" tone="muted" accessibilityRole="header">
                {heading}
              </AppText>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={sentence(row, symbol, decimals)}
              onPress={() => onOpen(activityId(row))}
              className="min-h-20 flex-row items-center gap-3 rounded-3xl border border-outline bg-surface p-4 active:bg-secondary-container"
            >
              <View className="size-12 items-center justify-center rounded-full bg-secondary-container">
                <Icon name={paid ? 'north_east' : 'south_west'} color={onContainer} />
              </View>
              <View className="flex-1 gap-1">
                <AppText variant="title">
                  {paid ? t('payment:activity.paidWord') : t('payment:activity.receivedWord')}
                </AppText>
                <Chip kind={statusKind(row.state)} label={statusWord(row)} />
              </View>
              <Amount
                size="row"
                value={`${paid ? '−' : '+'}${money}`}
                symbol={symbol}
                tone={paid ? 'strong' : 'success'}
              />
            </Pressable>
          </View>
        )
      })}
    </Screen>
  )
}
