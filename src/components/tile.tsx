import type { AndroidSymbol } from 'expo-symbols'
import { Pressable, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { feedback } from '../feedback'
import { useThemeColors } from '../theme/use-theme-colors'
import { AppText } from './app-text'
import { Icon } from './icon'

/** A big card for one thing to do. The accent goes to the main one only; the others stay on the neutral card. */
export function Tile({
  icon,
  title,
  hint,
  onPress,
  highlight = false,
  compact = false,
  testID,
}: {
  icon: AndroidSymbol
  title: string
  hint?: string
  onPress: () => void
  highlight?: boolean
  /** Icon and title on one row, for an entry that only leads somewhere. */
  compact?: boolean
  testID?: string
}) {
  const [onPrimary, foreground] = useThemeColors('on-primary', 'foreground')
  const scale = useSharedValue(1)
  const sink = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }))
  const look = highlight
    ? 'bg-primary active:bg-primary-pressed'
    : 'bg-surface border border-outline active:bg-secondary-container'
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={hint ? `${title}. ${hint}` : title}
      onPress={() => {
        feedback.cue('tap')
        onPress()
      }}
      onPressIn={() => {
        scale.set(withTiming(0.97, { duration: 80 }))
      }}
      onPressOut={() => {
        scale.set(withSpring(1, { damping: 14 }))
      }}
      className={`${compact ? 'min-h-16 p-4' : 'min-h-28 p-5'} flex-1 overflow-hidden rounded-3xl ${look}`}
    >
      <Animated.View style={sink} className={compact ? 'flex-row items-center gap-3' : 'gap-3'}>
        <Icon name={icon} size={compact ? 26 : 32} color={highlight ? onPrimary : foreground} />
        <View className={compact ? 'flex-1' : undefined}>
          <AppText variant="title" className={highlight ? 'text-on-primary' : ''}>
            {title}
          </AppText>
          {hint ? (
            <AppText variant="label" tone="muted" className={highlight ? 'text-on-primary' : ''}>
              {hint}
            </AppText>
          ) : null}
        </View>
      </Animated.View>
    </Pressable>
  )
}
