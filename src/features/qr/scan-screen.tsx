import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'
import type { TransferProgress } from '../../transport/types'
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
  const { t } = useTranslation(NAMESPACES)

  const insets = useSafeAreaInsets()
  const parts =
    progress && progress.total > 1 ? t('payment:scan.progress', { done: progress.done, total: progress.total }) : ''
  return (
    <View
      className="flex-1 gap-3 bg-background px-6 pt-6"
      style={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 16 }}
    >
      <AppText testID={hintTestID} variant="title" className="text-center" accessibilityLiveRegion="polite">
        {hint}
      </AppText>
      <View className="min-h-8 items-center justify-center" accessibilityLiveRegion="polite">
        {parts ? <Chip center kind="waiting" label={parts} /> : null}
        {notice ? <Chip center kind="problem" label={notice} /> : null}
      </View>
      <QrScanner onText={onText} />
      <Button variant="text" label={cancelLabel} onPress={onCancel} />
    </View>
  )
}
