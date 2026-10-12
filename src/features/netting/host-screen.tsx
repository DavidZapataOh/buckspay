import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { QrCode } from '../qr/qr-code'
import { fill, nettingCopy } from './copy'
import type { SessionView } from './session-view'

/** After this many failed spoke connections the person may choose to connect one friend at a time. */
const FALLBACK_AFTER = 2

export function HostScreen({
  view,
  invite,
  failure,
  onStart,
  onCancel,
  onOneAtATime,
}: {
  view: SessionView
  invite: string
  failure?: { reason: keyof typeof nettingCopy.host.failures; count: number }
  onStart: () => void
  onCancel: () => void
  onOneAtATime?: () => void
}) {
  const { host, privacy } = nettingCopy
  const lobby = view.state === 'lobby'
  return (
    <Screen testID="netting-host-screen">
      <AppText variant="headline">{host.title}</AppText>
      {lobby ? (
        <>
          <AppText variant="body">{host.scan}</AppText>
          <View testID="netting-qr" className="items-center">
            <QrCode text={invite} accessibilityLabel={host.scan} />
          </View>
          <AppText variant="title">{fill(host.joined, { count: view.count })}</AppText>
        </>
      ) : (
        <AppText variant="body">{view.headline}</AppText>
      )}
      {failure ? (
        <AppText variant="body" tone="danger" accessibilityLiveRegion="polite">
          {host.failures[failure.reason]}
        </AppText>
      ) : null}
      {failure && failure.count >= FALLBACK_AFTER && onOneAtATime ? (
        <Button testID="netting-one-at-a-time" variant="tonal" label={host.oneAtATime} onPress={onOneAtATime} />
      ) : null}
      <View className="gap-3">
        <Button
          testID="netting-start"
          variant="filled"
          label={host.start}
          disabled={!lobby || view.count < 2}
          onPress={onStart}
        />
        <Button testID="netting-cancel" variant="text" label={host.cancel} onPress={onCancel} />
      </View>
      <AppText variant="label" tone="muted">
        {privacy.group}
      </AppText>
      <AppText variant="label" tone="muted">
        {privacy.relay}
      </AppText>
    </Screen>
  )
}
