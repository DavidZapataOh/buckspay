import { useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { GRACE } from '../../protocol'
import { copy, text } from '../payment/copy'

/**
 * What settling in the clear publishes, said before the first settlement ever sent. Until the person
 * continues nothing is signed, and the count of payments waiting says what putting it off costs.
 */
export function SettlementLabel({
  count,
  earliestExpiry,
  onContinue,
}: {
  count: number
  earliestExpiry: number | null
  onContinue: () => void
}) {
  const [dismissed, setDismissed] = useState(false)
  const by = earliestExpiry === null ? '' : new Date((earliestExpiry + GRACE) * 1000).toLocaleDateString()
  return (
    <View testID="settlement-label" className="gap-3 rounded-3xl bg-surface p-5">
      <AppText variant="title" accessibilityRole="header">
        {copy.settlement.labelTitle}
      </AppText>
      <AppText variant="body">{copy.settlement.labelBody}</AppText>
      {count > 0 ? (
        <AppText testID="settlement-waiting" variant="body" tone="danger">
          {text(copy.settlement.waiting, { count, date: by })}
        </AppText>
      ) : null}
      {dismissed ? null : (
        <View className="flex-row gap-3">
          <Button
            testID="settlement-continue"
            variant="filled"
            label={copy.settlement.labelContinue}
            onPress={onContinue}
          />
          <Button
            testID="settlement-not-now"
            variant="text"
            label={copy.settlement.labelNotNow}
            onPress={() => setDismissed(true)}
          />
        </View>
      )}
    </View>
  )
}
