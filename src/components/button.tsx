import { useTranslation } from 'react-i18next'
import { NAMESPACES } from '../i18n'
import { ActivityIndicator, Pressable, Text } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { feedback } from '../feedback'
import { useThemeColors } from '../theme/use-theme-colors'

const variants = {
  filled: { container: 'bg-primary active:bg-primary-pressed', label: 'text-on-primary', content: 'on-primary' },
  tonal: {
    container: 'bg-secondary-container active:bg-secondary-container-pressed',
    label: 'text-on-secondary-container',
    content: 'on-secondary-container',
  },
  text: { container: 'active:bg-secondary-container', label: 'text-primary', content: 'primary' },
  danger: { container: 'bg-danger active:bg-danger-pressed', label: 'text-on-primary', content: 'on-primary' },
}

const disabledLook = { container: 'bg-disabled', label: 'text-on-disabled', content: 'on-disabled' }
const disabledText = { container: '', label: 'text-on-disabled', content: 'on-disabled' }

export type ButtonProps = {
  variant: keyof typeof variants
  label: string
  busy?: boolean
  disabled?: boolean
  onPress: () => void
  testID?: string
}

/**
 * A button that answers the finger: it sinks a little and darkens while pressed, ticks when pressed, and a
 * disabled one is desaturated rather than only faded. Its pressed state is also a ripple in its content color.
 */
export function Button({ variant, label, busy = false, disabled = false, onPress, testID }: ButtonProps) {
  const { t } = useTranslation(NAMESPACES)

  const {
    container,
    label: text,
    content,
  } = disabled ? (variant === 'text' ? disabledText : disabledLook) : variants[variant]
  const [color] = useThemeColors(content)
  const inactive = busy || disabled
  const scale = useSharedValue(1)
  const sink = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }))
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
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
      android_ripple={color ? { color: `${color}1f`, foreground: true } : undefined}
      className={`min-h-14 px-6 rounded-full overflow-hidden items-center justify-center ${container}`}
    >
      <Animated.View style={sink} className="items-center justify-center">
        {busy ? (
          <ActivityIndicator accessibilityLabel={t('common:working')} color={color} />
        ) : (
          <Text className={`text-base leading-6 font-semibold text-center ${text}`}>{label}</Text>
        )}
      </Animated.View>
    </Pressable>
  )
}
