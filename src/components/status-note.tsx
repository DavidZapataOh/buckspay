import { AppText } from './app-text'

/**
 * An inline error or notice. It stays mounted, empty without a message, so screen readers announce
 * a message when it appears or changes.
 */
export function StatusNote({
  tone,
  message,
  testID,
}: {
  tone: 'danger' | 'success' | 'muted' | 'default'
  message?: string
  testID?: string
}) {
  return (
    <AppText testID={testID} variant="body" tone={tone} accessibilityLiveRegion="polite">
      {message ?? ''}
    </AppText>
  )
}
