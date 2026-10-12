import { useTranslation } from 'react-i18next'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import { Hero } from '../../components/hero'
import { Info } from '../../components/info'
import { Screen } from '../../components/screen'
import { Stage } from '../../components/stage'
import { QrCode } from '../qr/qr-code'
import { NAMESPACES } from '../../i18n'
import { heroOf, type SessionView } from './session-view'

export type HostFailureReason = 'RadioOff' | 'Permission' | 'Unsupported' | 'Busy' | 'Timeout' | 'Rejected' | 'Error'

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
  failure?: { reason: HostFailureReason; count: number }
  onStart: () => void
  onCancel: () => void
  onOneAtATime?: () => void
}) {
  const { t } = useTranslation(NAMESPACES)
  const lobby = view.state === 'lobby'
  return (
    <Screen
      testID="netting-host-screen"
      steps={{ total: 3, current: 0 }}
      footer={
        <View className="gap-2">
          <Button
            testID="netting-start"
            variant="filled"
            label={t('netting:host.start')}
            disabled={!lobby || view.count < 2}
            onPress={onStart}
          />
          <Button testID="netting-cancel" variant="text" label={t('netting:host.cancel')} onPress={onCancel} />
        </View>
      }
    >
      {lobby ? (
        <View className="items-center gap-4">
          <View testID="netting-qr" className="items-center">
            <QrCode text={invite} accessibilityLabel={t('netting:host.askToScan')} />
          </View>
          <AppText variant="display" className="text-center" accessibilityLiveRegion="polite">
            {t('netting:host.joined', { count: view.count })}
          </AppText>
          <View className="flex-row items-center gap-1">
            <Chip center kind="waiting" label={view.line} />
            <Info
              title={t('netting:host.title')}
              lines={[t('netting:host.askToScan'), t('netting:privacy.group'), t('netting:privacy.relay')]}
            />
          </View>
        </View>
      ) : (
        <Stage
          hero={<Hero kind={heroOf(view) === 'nearby' ? 'waiting' : heroOf(view)} decorative />}
          title={view.headline}
        />
      )}
      {failure ? (
        <View accessibilityLiveRegion="polite" className="items-center">
          <Chip center kind="problem" label={t(`netting:host.failures.${failure.reason}`)} />
        </View>
      ) : null}
      {failure && failure.count >= FALLBACK_AFTER && onOneAtATime ? (
        <Button
          testID="netting-one-at-a-time"
          variant="tonal"
          label={t('netting:host.oneAtATime')}
          onPress={onOneAtATime}
        />
      ) : null}
    </Screen>
  )
}
