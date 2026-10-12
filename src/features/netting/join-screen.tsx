import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Screen } from '../../components/screen'
import { QrScanner } from '../qr/qr-scanner'
import { nettingCopy } from './copy'

export function JoinScreen({
  phase,
  onText,
  onCancel,
}: {
  phase: 'scan' | 'connecting' | 'not-found'
  onText: (text: string) => void
  onCancel: () => void
}) {
  const { join } = nettingCopy
  return (
    <Screen testID="netting-join-screen">
      <AppText variant="headline">{join.title}</AppText>
      {phase === 'scan' ? (
        <>
          <AppText testID="netting-scan-hint" variant="body">
            {join.scanHint}
          </AppText>
          <View className="min-h-96">
            <QrScanner onText={onText} />
          </View>
        </>
      ) : null}
      {phase === 'connecting' ? <AppText variant="body">{join.connecting}</AppText> : null}
      {phase === 'not-found' ? (
        <AppText variant="body" tone="danger" accessibilityLiveRegion="polite">
          {join.notFound}
        </AppText>
      ) : null}
      <Button testID="netting-cancel" variant="text" label={join.cancel} onPress={onCancel} />
    </Screen>
  )
}
