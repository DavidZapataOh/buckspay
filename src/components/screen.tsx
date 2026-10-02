import type { ReactNode } from 'react'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

/**
 * A screen's scrolling body on the theme background, inside the safe area. The status bar keeps an
 * opaque strip of the background: the app draws edge to edge, and content must not scroll under it.
 */
export function Screen({ children, testID }: { children: ReactNode; testID?: string }) {
  const insets = useSafeAreaInsets()
  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <ScrollView
        testID={testID}
        className="flex-1"
        contentContainerClassName="grow px-6 pt-6 gap-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        {children}
      </ScrollView>
    </View>
  )
}
