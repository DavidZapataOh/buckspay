import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import type { PlanRefusal } from '../../payment/preflight'

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
  const { t } = useTranslation(NAMESPACES)

  const sentence = t(`payment:refusal.${reason}.text`, values)
  const action = t(`payment:refusal.${reason}.action`)
  return (
    <View className="gap-6">
      <AppText testID="pay-refused" variant="body" accessibilityLiveRegion="polite">
        {sentence}
      </AppText>
      <Button testID="pay-refused-action" variant="filled" label={action} onPress={() => onAction(action)} />
    </View>
  )
}
