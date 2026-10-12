import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../../i18n'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'

/** What settling one note in the clear publishes about the people who held it, before it is settled. */
export function ClearNotice({
  holders,
  onSettle,
  onWait,
}: {
  holders: number
  onSettle: () => void
  onWait: () => void
}) {
  const { t } = useTranslation(NAMESPACES)

  return (
    <View testID="clear-notice" className="gap-3 rounded-3xl bg-surface p-5">
      <AppText variant="title" accessibilityRole="header">
        {t('payment:settlement.noticeTitle')}
      </AppText>
      <AppText variant="body">
        {holders === 1 ? t('payment:settlement.noticeOne') : t('payment:settlement.noticeMany', { count: holders })}
      </AppText>
      <View className="flex-row gap-3">
        <Button
          testID="notice-settle"
          variant="filled"
          label={t('payment:settlement.noticeSettle')}
          onPress={onSettle}
        />
        <Button testID="notice-wait" variant="text" label={t('payment:settlement.noticeWait')} onPress={onWait} />
      </View>
    </View>
  )
}
