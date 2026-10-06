import type { ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Screen } from '../../components/screen'
import { copy } from '../payment/copy'
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
}: {
  rows: readonly ActivityRow[]
  symbol: string
  decimals: number
  now: number
  onOpen: (id: string) => void
  /** What goes above the list: a notice that needs the person's attention. */
  header?: ReactNode
}) {
  const today = dayStart(now)
  const headings = rows.map((row, index) => {
    const start = dayStart(row.at)
    if (index > 0 && dayStart(rows[index - 1].at) === start) return undefined
    return start === today ? copy.activity.today : new Date(start).toLocaleDateString()
  })
  return (
    <Screen testID="activity">
      <AppText variant="headline">{copy.activity.title}</AppText>
      {header}
      {rows.length === 0 ? (
        <AppText variant="body" tone="muted">
          {copy.activity.empty}
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
