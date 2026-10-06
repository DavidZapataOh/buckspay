import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { ListRow } from '../../components/list-row'
import { Screen } from '../../components/screen'
import { eventCopy } from '../../features/event/copy'
import { listEvents, type StoredEvent } from '../../features/event/store'
import { nowSeconds, usePayments } from '../../features/payment/payments-provider'
import { text } from '../../features/payment/copy'

const ends = (event: StoredEvent) => text(eventCopy.ends, { date: new Date(event.endsAt * 1000).toLocaleString() })

export default function Events() {
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
      <AppText variant="headline">{eventCopy.title}</AppText>
      <View className="gap-1">
        <AppText variant="title" accessibilityRole="header">
          {eventCopy.joined}
        </AppText>
        {joined.length === 0 ? (
          <AppText variant="body" tone="muted">
            {eventCopy.none}
          </AppText>
        ) : null}
        {joined.map((event) => (
          <ListRow key={event.name + event.endsAt} testID="event-joined" title={event.name} value={ends(event)} />
        ))}
      </View>
      {organised.length > 0 ? (
        <View className="gap-1">
          <AppText variant="title" accessibilityRole="header">
            {eventCopy.organised}
          </AppText>
          {organised.map((event) => (
            <ListRow key={event.name + event.endsAt} testID="event-organised" title={event.name} value={ends(event)} />
          ))}
        </View>
      ) : null}
      <Button
        testID="events-join"
        variant="filled"
        label={eventCopy.join}
        onPress={() => router.push('/events/join')}
      />
      <Button testID="events-run" variant="tonal" label={eventCopy.run} onPress={() => router.push('/events/run')} />
    </Screen>
  )
}
