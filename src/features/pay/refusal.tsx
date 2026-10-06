import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import type { PlanRefusal } from '../../payment/preflight'
import { copy, text } from '../payment/copy'

/** What the payer is told when a request cannot be paid, and the one thing to do about it. */
export function PayRefused({
  reason,
  values,
  onAction,
}: {
  reason: PlanRefusal
  values: { max: string; amount: string; allowance: string }
  onAction: (action: string) => void
}) {
  const { text: sentence, action } = copy.refusal[reason]
  return (
    <View className="gap-6">
      <AppText testID="pay-refused" variant="body" accessibilityLiveRegion="polite">
        {text(sentence, values)}
      </AppText>
      <Button testID="pay-refused-action" variant="filled" label={action} onPress={() => onAction(action)} />
    </View>
  )
}
