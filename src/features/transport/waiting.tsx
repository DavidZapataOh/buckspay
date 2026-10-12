import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { View } from 'react-native'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Hero } from '../../components/hero'
import { Info } from '../../components/info'
import { Screen } from '../../components/screen'
import { Stage } from '../../components/stage'
import type { TransportId } from '../../transport/types'

/** What replaces the camera when the other phone talks over Tap or Nearby: waves while it looks, and the time left. */
export function WaitingScreen({
  medium,
  title,
  notice,
  detail,
  steps,
  onCancel,
  cancelLabel,
}: {
  medium: Exclude<TransportId, 'qr'>
  title: string
  notice?: string
  detail?: string
  steps?: { total: number; current: number }
  onCancel: () => void
  cancelLabel: string
}) {
  const { t } = useTranslation(NAMESPACES)

  return (
    <Screen testID="waiting-for-phone" steps={steps}>
      <Stage hero={<Hero kind="nearby" decorative />} title={title}>
        <View className="items-center gap-2">
          {detail ? <Chip kind="waiting" label={detail} /> : null}
          {notice ? (
            <View accessibilityLiveRegion="polite">
              <Chip kind="problem" label={notice} />
            </View>
          ) : null}
        </View>
        <Info title={title} lines={[t(`transport:waiting.${medium}`)]} />
        <Button testID="waiting-cancel" variant="text" label={cancelLabel} onPress={onCancel} />
      </Stage>
    </Screen>
  )
}
