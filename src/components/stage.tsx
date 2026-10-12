import type { ReactNode } from 'react'
import { View } from 'react-native'
import { AppText, type AppTextProps } from './app-text'

/** One thing in the middle of the screen: a picture, a title of a few words, at most one line, and what to do. */
export function Stage({
  hero,
  title,
  tone,
  line,
  children,
  testID,
}: {
  hero: ReactNode
  title: string
  tone?: AppTextProps['tone']
  line?: string
  children?: ReactNode
  testID?: string
}) {
  return (
    <View testID={testID} className="items-center gap-4 pt-2">
      {hero}
      <AppText variant="headline" tone={tone} className="text-center" accessibilityLiveRegion="polite">
        {title}
      </AppText>
      {line ? (
        <AppText variant="body" tone="muted" className="text-center">
          {line}
        </AppText>
      ) : null}
      {children}
    </View>
  )
}
