import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { copy } from '../payment/copy'
import { QrScanner } from '../qr/qr-scanner'
import { remoteCopy } from './copy'

/** Adds a contact: the camera on a pay link, or the link pasted from the clipboard. */
export function FarAwayLink({
  notice,
  onText,
  onPaste,
  onCancel,
}: {
  notice?: string
  onText: (text: string) => void
  onPaste: () => void
  onCancel: () => void
}) {
  const insets = useSafeAreaInsets()
  return (
    <View
      className="flex-1 gap-3 bg-background px-6 pt-6"
      style={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 16 }}
    >
      <AppText variant="body">{remoteCopy.scanLink}</AppText>
      <AppText variant="body" tone="danger" accessibilityLiveRegion="polite">
        {notice ?? ''}
      </AppText>
      <QrScanner onText={onText} />
      <Button variant="tonal" label={remoteCopy.paste} onPress={onPaste} />
      <Button variant="text" label={copy.review.cancel} onPress={onCancel} />
    </View>
  )
}
