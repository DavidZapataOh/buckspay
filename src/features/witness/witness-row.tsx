import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { View } from 'react-native'
import { Button } from '../../components/button'
import { Chip } from '../../components/chip'

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
  const { t } = useTranslation(NAMESPACES)

  if (policy === 'off' || state.phase === 'off') return null
  const held = role === 'receiver' && !mayReleaseNow(policy, state)
  const { phase } = state
  const sentence = {
    checking: held
      ? t('witness:requiredChecking')
      : role === 'receiver'
        ? t('witness:receiverChecking')
        : t('witness:payerChecking'),
    seen: t('witness:seen'),
    'not-seen': held ? t('witness:requiredNotSeen') : t('witness:notSeen'),
    unavailable: t('witness:unavailable'),
    failed: t('witness:failed'),
    'low-volume': t('witness:lowVolume'),
    skipped: t('witness:skipped'),
    off: '',
  }[phase]
  const kind = {
    checking: 'waiting',
    seen: 'done',
    'not-seen': held ? 'problem' : 'waiting',
    unavailable: 'problem',
    failed: 'problem',
    'low-volume': 'problem',
    skipped: 'info',
    off: 'info',
  }[phase] as 'done' | 'waiting' | 'problem' | 'info'
  return (
    <View testID="witness-row" accessibilityLiveRegion="polite" className="w-full items-center gap-3">
      <Chip center kind={kind} icon="hearing" label={sentence} />
      <View className="w-full gap-2">
        {role === 'receiver' && phase === 'checking' && !held ? (
          <Button testID="witness-skip" variant="text" label={t('witness:skip')} onPress={onSkip} />
        ) : null}
        {role === 'receiver' && canRetry(state) ? (
          <Button testID="witness-retry" variant="tonal" label={t('witness:tryAgain')} onPress={onRetry} />
        ) : null}
        {held && (phase === 'not-seen' || phase === 'failed' || phase === 'low-volume') ? (
          <Button testID="witness-continue" variant="text" label={t('witness:continueAnyway')} onPress={onContinue} />
        ) : null}
        {phase === 'not-seen' ? (
          <Button testID="witness-meaning" variant="text" label={t('witness:whatThisMeans')} onPress={onMeaning} />
        ) : null}
        {phase === 'unavailable' ? (
          <Button
            testID="witness-settings"
            variant="tonal"
            label={t('witness:openSettings')}
            onPress={onOpenSettings}
          />
        ) : null}
      </View>
    </View>
  )
}
