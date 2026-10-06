import { AppText } from '../../components/app-text'

/** A check or a cross beside a result, so colour is never the only thing that says how it went. */
export function ResultMark({ ok }: { ok: boolean }) {
  return (
    <AppText
      variant="display"
      tone={ok ? 'success' : 'danger'}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {ok ? '✓' : '✕'}
    </AppText>
  )
}
