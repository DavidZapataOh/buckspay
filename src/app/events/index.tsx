import { formatDateTime } from '../../i18n/format'
import { i18n, currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Chip } from '../../components/chip'
import { Tile } from '../../components/tile'
import { Screen } from '../../components/screen'

import { listEvents, type StoredEvent } from '../../features/event/store'
import { nowSeconds, usePayments } from '../../features/payment/payments-provider'

const ends = (event: StoredEvent) => i18n.t('event:ends', { date: formatDateTime(event.endsAt, currentLanguage()) })

export default function Events() {
  const { t } = useTranslation(NAMESPACES)

  const { db } = usePayments()
  const [joined, setJoined] = useState<StoredEvent[]>([])
  const [organised, setOrganised] = useState<StoredEvent[]>([])

  useEffect(() => {
    if (!db) return
    let live = true
    void Promise.all([listEvents(db, 'attendee'), listEvents(db, 'organiser')]).then(([attending, running]) => {
      if (!live) return
      setJoined(attending.filter((event) => event.endsAt > nowSeconds()))
      setOrganised(running)
    })
    return () => {
      live = false
    }
  }, [db])

  return (
    <Screen testID="events">
      <View className="gap-1">
        <AppText variant="title" accessibilityRole="header">
          {t('event:joined')}
        </AppText>
        {joined.length === 0 ? (
          <AppText variant="body" tone="muted">
            {t('event:none')}
          </AppText>
        ) : null}
        {joined.map((event) => (
          <View
            key={event.name + event.endsAt}
            testID="event-joined"
            accessible
            className="gap-1 rounded-3xl border border-outline bg-surface p-4"
          >
            <AppText variant="title">{event.name}</AppText>
            <Chip kind="info" icon="event" label={ends(event)} />
          </View>
        ))}
      </View>
      {organised.length > 0 ? (
        <View className="gap-1">
          <AppText variant="title" accessibilityRole="header">
            {t('event:organised')}
          </AppText>
          {organised.map((event) => (
            <View
              key={event.name + event.endsAt}
              testID="event-organised"
              accessible
              className="gap-1 rounded-3xl border border-outline bg-surface p-4"
            >
              <AppText variant="title">{event.name}</AppText>
              <Chip kind="info" icon="event" label={ends(event)} />
            </View>
          ))}
        </View>
      ) : null}
      <View className="flex-row gap-3">
        <Tile
          testID="events-join"
          highlight
          icon="qr_code_scanner"
          title={t('event:join')}
          onPress={() => router.push('/events/join')}
        />
        <Tile testID="events-run" icon="campaign" title={t('event:run')} onPress={() => router.push('/events/run')} />
      </View>
    </Screen>
  )
}
