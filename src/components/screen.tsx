import type { ReactNode } from 'react'
import { ScrollView, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { actionBarPadding } from '../utils/action-bar'
import { StepBar } from './step-bar'

/**
 * A screen's scrolling body on the theme background, inside the safe area. The status bar keeps an
 * opaque strip of the background: the app draws edge to edge, and content must not scroll under it.
 * A `footer` stays below the scrolling body, clear of the system bar, so its buttons are always in view.
 * `steps` shows where the person is in a flow.
 */
export function Screen({
  children,
  testID,
  footer,
  steps,
}: {
  children: ReactNode
  testID?: string
  footer?: ReactNode
  steps?: { total: number; current: number }
}) {
  const insets = useSafeAreaInsets()
  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      {steps ? (
        <View className="px-6 pt-4">
          <StepBar total={steps.total} current={steps.current} />
        </View>
      ) : null}
      <ScrollView
        testID={testID}
        className="flex-1"
        contentContainerClassName="grow px-6 pt-6 gap-4"
        contentContainerStyle={{ paddingBottom: footer ? 16 : insets.bottom + 24 }}
      >
        {children}
      </ScrollView>
      {footer ? (
        <View testID="screen-footer" className="px-6 pt-3" style={{ paddingBottom: actionBarPadding(insets.bottom) }}>
          {footer}
        </View>
      ) : null}
    </View>
  )
}
