import { formatDateTime } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { getAddressDecoder } from '@solana/kit'
import { useState } from 'react'
import { View } from 'react-native'
import { AddressRow } from '../../components/address-row'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { StatusNote } from '../../components/status-note'

import type { EventInvite } from './payloads'

type Joined = 'joined' | 'known' | 'ended'

/** What an attendee sees of a scanned invite, and the one action it has: accepting that event's credit. */
export function JoinInvite({
  invite,
  onJoin,
  onDone,
}: {
  invite: EventInvite
  onJoin: (invite: EventInvite) => Promise<Joined>
  onDone: () => void
}) {
  const { t } = useTranslation(NAMESPACES)

  const [result, setResult] = useState<Joined>()
  const [busy, setBusy] = useState(false)
  const message =
    result === 'ended'
      ? t('event:ended')
      : result === 'joined'
        ? t('event:nowAccepting', { name: invite.name })
        : result === 'known'
          ? t('event:already', { name: invite.name })
          : undefined

  async function accept() {
    setBusy(true)
    setResult(await onJoin(invite))
    setBusy(false)
  }

  return (
    <View testID="join-invite" className="gap-4">
      <AppText variant="headline">{invite.name}</AppText>
      <AddressRow
        testID="join-organiser"
        address={getAddressDecoder().decode(invite.authority)}
        label={t('event:organiser')}
      />
      <AppText variant="body" tone="muted">
        {t('event:ends', { date: formatDateTime(invite.endsAt, currentLanguage()) })}
      </AppText>
      <StatusNote tone={result === 'ended' ? 'danger' : 'default'} message={message} />
      {result === 'joined' || result === 'known' ? (
        <Button testID="join-done" variant="filled" label={t('common:done')} onPress={onDone} />
      ) : (
        <Button
          testID="join-accept"
          variant="filled"
          label={t('event:accept')}
          busy={busy}
          disabled={busy}
          onPress={() => void accept()}
        />
      )}
    </View>
  )
}
