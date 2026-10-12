import { useTranslation } from 'react-i18next'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { formatDate } from '../../i18n/format'
import type { ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Screen } from '../../components/screen'

import type { ActivityRow } from '../notes/activity'
import { activityId, sentence } from './format'

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

  const today = dayStart(now)
  const headings = rows.map((row, index) => {
    const start = dayStart(row.at)
    if (index > 0 && dayStart(rows[index - 1].at) === start) return undefined
    return start === today ? t('payment:activity.today') : formatDate(start / 1000, currentLanguage())
  })
  return (
    <Screen testID="activity">
      <AppText variant="headline">{t('payment:activity.title')}</AppText>
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
        <AppText variant="body" tone="muted">
          {t('payment:activity.empty')}
        </AppText>
      ) : null}
      {rows.map((row, index) => {
        const heading = headings[index]
        return (
          <View key={activityId(row)} className="gap-1">
            {heading ? (
              <AppText variant="label" tone="muted" accessibilityRole="header">
                {heading}
              </AppText>
            ) : null}
            <Pressable
              accessibilityRole="button"
              onPress={() => onOpen(activityId(row))}
              className="min-h-14 justify-center py-2"
            >
              <AppText variant="body">{sentence(row, symbol, decimals)}</AppText>
            </Pressable>
          </View>
        )
      })}
    </Screen>
  )
}
