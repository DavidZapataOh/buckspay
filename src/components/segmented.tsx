import type { AndroidSymbol } from 'expo-symbols'
import { Pressable, View } from 'react-native'
import { feedback } from '../feedback'
import { useThemeColors } from '../theme/use-theme-colors'
import { AppText } from './app-text'
import { Icon } from './icon'

export type SegmentOption<T extends string> = { id: T; label: string; icon?: AndroidSymbol; testID?: string }

/** A few options side by side, the chosen one filled: a tap picks it and answers with a tick. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  testID,
}: {
  options: readonly SegmentOption<T>[]
  value: T
  onChange: (id: T) => void
  testID?: string
}) {
  const [onContainer, muted] = useThemeColors('on-secondary-container', 'muted')
  return (
    <View testID={testID} accessibilityRole="radiogroup" className="flex-row flex-wrap gap-2">
      {options.map((option) => {
        const selected = option.id === value
        return (
          <Pressable
            key={option.id}
            testID={option.testID}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
            onPress={() => {
              if (!selected) feedback.cue('tap')
              onChange(option.id)
            }}
            className={`min-h-12 flex-1 flex-row items-center justify-center gap-2 rounded-2xl px-3 ${
              selected ? 'bg-secondary-container' : 'border border-outline bg-surface'
            }`}
          >
            {option.icon ? <Icon name={option.icon} size={20} color={selected ? onContainer : muted} /> : null}
            <AppText variant="label" tone={selected ? 'default' : 'muted'}>
              {option.label}
            </AppText>
          </Pressable>
        )
      })}
    </View>
  )
}
