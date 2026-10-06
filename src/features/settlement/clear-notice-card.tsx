import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { copy, text } from '../payment/copy'

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
  return (
    <View testID="clear-notice" className="gap-3 rounded-3xl bg-surface p-5">
      <AppText variant="title" accessibilityRole="header">
        {copy.settlement.noticeTitle}
      </AppText>
      <AppText variant="body">
        {holders === 1 ? copy.settlement.noticeOne : text(copy.settlement.noticeMany, { count: holders })}
      </AppText>
      <View className="flex-row gap-3">
        <Button testID="notice-settle" variant="filled" label={copy.settlement.noticeSettle} onPress={onSettle} />
        <Button testID="notice-wait" variant="text" label={copy.settlement.noticeWait} onPress={onWait} />
      </View>
    </View>
  )
}
