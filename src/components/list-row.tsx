import { View } from 'react-native'
import { AppText } from './app-text'

/** A titled value, read by screen readers as one element. */
export function ListRow({ title, value, testID }: { title: string; value: string; testID?: string }) {
  return (
    <View testID={testID} accessible className="min-h-14 py-2 justify-center">
      <AppText variant="body">{title}</AppText>
      <AppText variant="label" tone="muted">
        {value}
      </AppText>
    </View>
  )
}
