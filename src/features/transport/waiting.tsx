import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { QrPresenter } from '../qr/qr-presenter'
import type { TransportId } from '../../transport/types'

/** What replaces the camera when the other phone talks over Tap or Nearby: nothing to scan, only to wait. */
export function WaitingScreen({
  medium,
  title,
  notice,
  detail,
  code,
  onCancel,
  cancelLabel,
}: {
  medium: Exclude<TransportId, 'qr'>
  title: string
  notice?: string
  detail?: string
  /** A code the other phone scans to find this one, shown while it waits. */
  code?: string
  onCancel: () => void
  cancelLabel: string
}) {
  const { t } = useTranslation(NAMESPACES)

  return (
    <Screen testID="waiting-for-phone">
      <View className="gap-4">
        <AppText variant="headline" accessibilityLiveRegion="polite">
          {title}
        </AppText>
        {code ? <QrPresenter texts={[code]} accessibilityLabel={title} /> : null}
        <AppText variant="body">{t(`transport:waiting.${medium}`)}</AppText>
        {detail ? (
          <AppText variant="body" tone="muted">
            {detail}
          </AppText>
        ) : null}
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
