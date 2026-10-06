import { ActivityIndicator, Pressable, Text } from 'react-native'
import { useThemeColors } from '../theme/use-theme-colors'

const variants = {
  filled: { container: 'bg-primary', label: 'text-on-primary', content: 'on-primary' },
  tonal: {
    container: 'bg-secondary-container',
    label: 'text-on-secondary-container',
    content: 'on-secondary-container',
  },
  text: { container: '', label: 'text-primary', content: 'primary' },
  danger: { container: 'bg-danger', label: 'text-on-primary', content: 'on-primary' },
}

export type ButtonProps = {
  variant: keyof typeof variants
  label: string
  busy?: boolean
  disabled?: boolean
  onPress: () => void
  testID?: string
}

/** A Material 3 button: its pressed state is a ripple in its content color at 12% opacity. */
export function Button({ variant, label, busy = false, disabled = false, onPress, testID }: ButtonProps) {
  const { container, label: text, content } = variants[variant]
  const [color] = useThemeColors(content)
  const inactive = busy || disabled
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      android_ripple={color ? { color: `${color}1f`, foreground: true } : undefined}
      className={`min-h-12 px-6 rounded-full overflow-hidden items-center justify-center ${container} ${disabled ? 'opacity-40' : ''}`}
    >
      {busy ? (
        <ActivityIndicator accessibilityLabel="Working" color={color} />
      ) : (
        <Text className={`text-base leading-6 font-medium text-center ${text}`}>{label}</Text>
      )}
    </Pressable>
  )
}
