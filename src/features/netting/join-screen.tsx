import { useTranslation } from 'react-i18next'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { QrScanner } from '../qr/qr-scanner'
import { NAMESPACES } from '../../i18n'

export function JoinScreen({
  phase,
  onText,
  onCancel,
}: {
  phase: 'scan' | 'connecting' | 'not-found'
  onText: (text: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation(NAMESPACES)
  return (
    <Screen testID="netting-join-screen">
      <AppText variant="headline">{t('netting:join.title')}</AppText>
      {phase === 'scan' ? (
        <>
          <AppText testID="netting-scan-hint" variant="body">
            {t('netting:join.scanHint')}
          </AppText>
          <View className="min-h-96">
            <QrScanner onText={onText} />
          </View>
        </>
      ) : null}
      {phase === 'connecting' ? <AppText variant="body">{t('netting:join.connecting')}</AppText> : null}
      {phase === 'not-found' ? (
        <AppText variant="body" tone="danger" accessibilityLiveRegion="polite">
          {t('netting:join.notFound')}
        </AppText>
      ) : null}
      <Button testID="netting-cancel" variant="text" label={t('netting:join.cancel')} onPress={onCancel} />
    </Screen>
  )
}
