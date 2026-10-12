import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { StatusNote } from '../../components/status-note'
import { TextField } from '../../components/text-field'
import { QrPresenter } from '../qr/qr-presenter'
import { useQrSession } from '../payment/use-qr-session'
import { MessageKind } from '../../transport/types'

import { encodeInvite, encodePairing, type PointPairing } from './payloads'

const HOUR = 3600

/** A new event of the organiser: the account that redeems its credit is the organiser's wallet, the issuers its own device. */
export function newEvent(input: {
  name: string
  hours: number
  authority: Uint8Array
  issuer: Uint8Array
  now: number
}): PointPairing {
  return {
    eventId: crypto.getRandomValues(new Uint8Array(16)),
    authority: input.authority,
    name: input.name,
    endsAt: input.now + Math.round(input.hours * HOUR),
    eventSecret: crypto.getRandomValues(new Uint8Array(32)),
    issuers: [input.issuer],
  }
}

/** The form that creates an event, then its two codes: the invite for attendees and the pairing for points. */
export function RunEvent({
  event,
  onCreate,
  error,
}: {
  event: PointPairing | null
  onCreate: (name: string, hours: number) => void
  error?: string
}) {
  const { t } = useTranslation(NAMESPACES)

  const [name, setName] = useState('')
  const [hours, setHours] = useState('8')
  const invite = useQrSession()
  const { transport: pairTransport, texts: pairTexts, clear: clearPairing } = useQrSession()
  const [reveal, setReveal] = useState(false)

  useEffect(() => {
    if (!event) return
    const controller = new AbortController()
    void invite.transport
      .send({ kind: MessageKind.EventInvite, payload: encodeInvite(event) }, { signal: controller.signal })
      .catch(() => undefined)
    return () => controller.abort()
  }, [event, invite.transport])

  useEffect(() => {
    if (!event || !reveal) return
    const controller = new AbortController()
    void pairTransport
      .send({ kind: MessageKind.PointPairing, payload: encodePairing(event) }, { signal: controller.signal })
      .catch(() => undefined)
    return () => {
      controller.abort()
      clearPairing()
    }
  }, [event, reveal, pairTransport, clearPairing])

  if (!event) {
    const valid = name.trim().length > 0 && Number(hours) > 0
    return (
      <View testID="run-form" className="gap-4">
        <AppText variant="headline">{t('event:runTitle')}</AppText>
        <TextField testID="run-name" label={t('event:name')} value={name} onChangeText={setName} />
        <TextField
          testID="run-hours"
          label={t('event:hours')}
          keyboardType="decimal-pad"
          value={hours}
          onChangeText={setHours}
        />
        <StatusNote tone="danger" message={error} />
        <Button
          testID="run-create"
          variant="filled"
          label={t('event:create')}
          disabled={!valid}
          onPress={() => onCreate(name.trim(), Number(hours))}
        />
      </View>
    )
  }
  return (
    <View testID="run-codes" className="gap-6">
      <AppText variant="headline">{event.name}</AppText>
      <View className="gap-2">
        <AppText variant="title">{t('event:invite')}</AppText>
        {invite.texts ? <QrPresenter texts={invite.texts} accessibilityLabel={t('event:invite')} /> : null}
      </View>
      <View className="gap-2">
        <AppText variant="title">{t('event:pair')}</AppText>
        <AppText variant="label" tone="muted">
          {t('event:secretNote')}
        </AppText>
        {reveal && pairTexts ? (
          <QrPresenter texts={pairTexts} accessibilityLabel={t('event:pair')} />
        ) : (
          <Pressable
            testID="run-reveal"
            accessibilityRole="button"
            accessibilityLabel={t('event:holdToReveal')}
            className="min-h-12 justify-center rounded-3xl bg-surface p-5"
            onPressIn={() => setReveal(true)}
            onPressOut={() => setReveal(false)}
          >
            <AppText variant="body">{t('event:holdToReveal')}</AppText>
          </Pressable>
        )}
      </View>
    </View>
  )
}
