import { useTranslation } from 'react-i18next'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Hero } from '../../components/hero'
import { Screen } from '../../components/screen'
import { Stage } from '../../components/stage'
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
    <Screen testID="netting-join-screen" steps={{ total: 3, current: 0 }}>
      {phase === 'scan' ? (
        <>
          <AppText testID="netting-scan-hint" variant="title" className="text-center">
            {t('netting:join.scanHint')}
          </AppText>
          <View className="min-h-96">
            <QrScanner onText={onText} />
          </View>
        </>
      ) : null}
      {phase === 'connecting' ? (
        <Stage hero={<Hero kind="nearby" decorative />} title={t('netting:join.connecting')} />
      ) : null}
      {phase === 'not-found' ? (
        <View accessibilityLiveRegion="polite">
          <Stage hero={<Hero kind="problem" decorative />} title={t('netting:join.notFound')} />
        </View>
      ) : null}
      <Button testID="netting-cancel" variant="text" label={t('netting:join.cancel')} onPress={onCancel} />
    </Screen>
  )
}
