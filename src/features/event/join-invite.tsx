import { formatDateTime } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { getAddressDecoder } from '@solana/kit'
import { useState } from 'react'
import { View } from 'react-native'
import { AddressRow } from '../../components/address-row'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Hero } from '../../components/hero'
import { Stage } from '../../components/stage'

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
      <Stage hero={<Hero kind={result === 'ended' ? 'problem' : 'coins'} decorative size={120} />} title={invite.name}>
        {message ? (
          <View accessibilityLiveRegion="polite">
            <Chip center kind={result === 'ended' ? 'problem' : 'done'} label={message} />
          </View>
        ) : null}
      </Stage>
      <AddressRow
        testID="join-organiser"
        address={getAddressDecoder().decode(invite.authority)}
        label={t('event:organiser')}
      />
      <Chip
        center
        kind="info"
        icon="event"
        label={t('event:ends', { date: formatDateTime(invite.endsAt, currentLanguage()) })}
      />
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
