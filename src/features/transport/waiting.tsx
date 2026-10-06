import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import type { TransportId } from '../../transport/types'
import { howCopy } from './copy'

/** What replaces the camera when the other phone talks over Tap or Nearby: nothing to scan, only to wait. */
export function WaitingScreen({
  medium,
  title,
  notice,
  onCancel,
  cancelLabel,
}: {
  medium: Exclude<TransportId, 'qr'>
  title: string
  notice?: string
  onCancel: () => void
  cancelLabel: string
}) {
  return (
    <Screen testID="waiting-for-phone">
      <View className="gap-4">
        <AppText variant="headline" accessibilityLiveRegion="polite">
          {title}
        </AppText>
        <AppText variant="body">{howCopy.waiting[medium]}</AppText>
        {notice ? (
          <AppText variant="body" tone="danger" accessibilityLiveRegion="polite">
            {notice}
          </AppText>
        ) : null}
        <Button testID="waiting-cancel" variant="text" label={cancelLabel} onPress={onCancel} />
      </View>
    </Screen>
  )
}
