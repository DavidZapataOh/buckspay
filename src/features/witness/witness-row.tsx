import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { witnessCopy as copy } from './copy'
import type { WitnessPolicy } from './policy'
import { canRetry, mayReleaseNow, type WitnessState } from './witness-state'

export type WitnessRowProps = {
  role: 'payer' | 'receiver'
  policy: WitnessPolicy
  state: WitnessState
  onSkip: () => void
  onRetry: () => void
  onContinue: () => void
  onMeaning: () => void
  onOpenSettings: () => void
}

/** The line of a result screen that says whether the other phone was heard. */
export function WitnessRow({
  role,
  policy,
  state,
  onSkip,
  onRetry,
  onContinue,
  onMeaning,
  onOpenSettings,
}: WitnessRowProps) {
  if (policy === 'off' || state.phase === 'off') return null
  const held = role === 'receiver' && !mayReleaseNow(policy, state)
  const { phase } = state
  const sentence = {
    checking: held ? copy.requiredChecking : role === 'receiver' ? copy.receiverChecking : copy.payerChecking,
    seen: copy.seen,
    'not-seen': held ? copy.requiredNotSeen : copy.notSeen,
    unavailable: copy.unavailable,
    skipped: copy.skipped,
    off: '',
  }[phase]
  return (
    <View testID="witness-row" accessibilityLiveRegion="polite" className="gap-3">
      <AppText variant={held ? 'title' : 'body'} accessibilityRole={held ? 'header' : undefined}>
        {sentence}
      </AppText>
      {role === 'receiver' && phase === 'checking' && !held ? (
        <Button testID="witness-skip" variant="text" label={copy.skip} onPress={onSkip} />
      ) : null}
      {role === 'receiver' && phase === 'not-seen' && canRetry(state) ? (
        <Button testID="witness-retry" variant="tonal" label={copy.tryAgain} onPress={onRetry} />
      ) : null}
      {held && phase === 'not-seen' ? (
        <Button testID="witness-continue" variant="text" label={copy.continueAnyway} onPress={onContinue} />
      ) : null}
      {phase === 'not-seen' ? (
        <Button testID="witness-meaning" variant="text" label={copy.whatThisMeans} onPress={onMeaning} />
      ) : null}
      {phase === 'unavailable' ? (
        <Button testID="witness-settings" variant="tonal" label={copy.openSettings} onPress={onOpenSettings} />
      ) : null}
    </View>
  )
}
