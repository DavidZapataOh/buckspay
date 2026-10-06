import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { Screen } from '../../components/screen'
import { eventCopy } from '../../features/event/copy'
import { JoinInvite } from '../../features/event/join-invite'
import { decodeInvite, type EventInvite } from '../../features/event/payloads'
import { joinEvent } from '../../features/event/store'
import { nowSeconds, usePayments } from '../../features/payment/payments-provider'
import { useQrSession } from '../../features/payment/use-qr-session'
import { ScanScreen } from '../../features/qr/scan-screen'
import { MessageKind } from '../../transport/types'

export default function JoinEvent() {
  const { db } = usePayments()
  const session = useQrSession()
  const [invite, setInvite] = useState<EventInvite>()
  const [notInvite, setNotInvite] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void session.transport.receive({ accept: [MessageKind.EventInvite], signal: controller.signal }).then(
      (message) => {
        try {
          setInvite(decodeInvite(message.payload))
        } catch {
          setNotInvite(true)
        }
      },
      () => undefined,
    )
    return () => controller.abort()
  }, [session.transport])

  if (!invite) {
    return (
      <ScanScreen
        hint={eventCopy.scanInvite}
        hintTestID="join-scanning"
        progress={session.progress}
        notice={notInvite ? eventCopy.notInvite : undefined}
        onText={session.push}
        onCancel={() => router.back()}
        cancelLabel="Cancel"
      />
    )
  }
  return (
    <Screen testID="join-screen">
      <JoinInvite
        invite={invite}
        onJoin={async (scanned) => {
          if (!db) throw new Error('The payments store is not open')
          return joinEvent(db, scanned, nowSeconds())
        }}
        onDone={() => router.back()}
      />
    </Screen>
  )
}
