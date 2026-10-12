import { formatDate } from '../../i18n/format'
import { currentLanguage, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { GRACE } from '../../protocol'

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
  const { t } = useTranslation(NAMESPACES)

  const [dismissed, setDismissed] = useState(false)
  const by = earliestExpiry === null ? '' : formatDate(earliestExpiry + GRACE, currentLanguage())
  return (
    <View testID="settlement-label" className="gap-3 rounded-3xl bg-surface p-5">
      <AppText variant="title" accessibilityRole="header">
        {t('payment:settlement.labelTitle')}
      </AppText>
      <AppText variant="body">{t('payment:settlement.labelBody')}</AppText>
      {count > 0 ? (
        <AppText testID="settlement-waiting" variant="body" tone="danger">
          {t('payment:settlement.waiting', { count, date: by })}
        </AppText>
      ) : null}
      {dismissed ? null : (
        <View className="flex-row gap-3">
          <Button
            testID="settlement-continue"
            variant="filled"
            label={t('payment:settlement.labelContinue')}
            onPress={onContinue}
          />
          <Button
            testID="settlement-not-now"
            variant="text"
            label={t('payment:settlement.labelNotNow')}
            onPress={() => setDismissed(true)}
          />
        </View>
      )}
    </View>
  )
}
