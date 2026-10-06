import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import type { TransferProgress } from '../../transport/types'
import { copy, text } from '../payment/copy'
import { QrScanner } from './qr-scanner'

/** The camera under a short instruction, with the progress of a code made of several parts and a way out. */
export function ScanScreen({
  hint,
  hintTestID,
  progress,
  notice,
  onText,
  onCancel,
  cancelLabel,
}: {
  hint: string
  hintTestID: string
  progress?: TransferProgress
  /** Said above the camera when the last code was not the one expected. */
  notice?: string
  onText: (text: string) => void
  onCancel: () => void
  cancelLabel: string
}) {
  const insets = useSafeAreaInsets()
  return (
    <View
      className="flex-1 gap-3 bg-background px-6 pt-6"
      style={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 16 }}
    >
      <AppText testID={hintTestID} variant="body" accessibilityLiveRegion="polite">
        {hint}
      </AppText>
      <AppText variant="label" tone="muted" accessibilityLiveRegion="polite">
        {progress && progress.total > 1 ? text(copy.scan.progress, { done: progress.done, total: progress.total }) : ''}
      </AppText>
      <AppText variant="body" tone="danger" accessibilityLiveRegion="polite">
        {notice ?? ''}
      </AppText>
      <QrScanner onText={onText} />
      <Button variant="text" label={cancelLabel} onPress={onCancel} />
    </View>
  )
}
