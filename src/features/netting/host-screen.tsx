import { useTranslation } from 'react-i18next'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { QrCode } from '../qr/qr-code'
import { NAMESPACES } from '../../i18n'
import type { SessionView } from './session-view'

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
    <Screen testID="netting-host-screen">
      <AppText variant="headline">{t('netting:host.title')}</AppText>
      {lobby ? (
        <>
          <AppText variant="body">{t('netting:host.askToScan')}</AppText>
          <View testID="netting-qr" className="items-center">
            <QrCode text={invite} accessibilityLabel={t('netting:host.askToScan')} />
          </View>
          <AppText variant="title">{t('netting:host.joined', { count: view.count })}</AppText>
        </>
      ) : (
        <AppText variant="body">{view.headline}</AppText>
      )}
      {failure ? (
        <AppText variant="body" tone="danger" accessibilityLiveRegion="polite">
          {t(`netting:host.failures.${failure.reason}`)}
        </AppText>
      ) : null}
      {failure && failure.count >= FALLBACK_AFTER && onOneAtATime ? (
        <Button
          testID="netting-one-at-a-time"
          variant="tonal"
          label={t('netting:host.oneAtATime')}
          onPress={onOneAtATime}
        />
      ) : null}
      <View className="gap-3">
        <Button
          testID="netting-start"
          variant="filled"
          label={t('netting:host.start')}
          disabled={!lobby || view.count < 2}
          onPress={onStart}
        />
        <Button testID="netting-cancel" variant="text" label={t('netting:host.cancel')} onPress={onCancel} />
      </View>
      <AppText variant="label" tone="muted">
        {t('netting:privacy.group')}
      </AppText>
      <AppText variant="label" tone="muted">
        {t('netting:privacy.relay')}
      </AppText>
    </Screen>
  )
}
