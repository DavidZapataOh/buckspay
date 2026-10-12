import type { ReactNode } from 'react'
import { View } from 'react-native'
import { AppText } from './app-text'

/** A group of things that belong together, on the neutral foreground with a soft border instead of a fill. */
export function Card({ title, children, testID }: { title?: string; children: ReactNode; testID?: string }) {
  return (
    <View testID={testID} className="gap-2 rounded-3xl border border-outline bg-surface p-5">
      {title ? (
        <AppText variant="title" accessibilityRole="header">
          {title}
        </AppText>
      ) : null}
      {children}
    </View>
  )
}
