import type { AndroidSymbol } from 'expo-symbols'
import { Pressable } from 'react-native'
import { useThemeColors } from '../theme/use-theme-colors'
import { Icon } from './icon'

/** A 48 dp icon button with a borderless ripple, labelled for screen readers. */
export function IconButton({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: AndroidSymbol
  label: string
  onPress: () => void
  testID?: string
}) {
  const [muted, foreground] = useThemeColors('muted', 'foreground')
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      android_ripple={foreground ? { color: `${foreground}1f`, borderless: true, radius: 24 } : undefined}
      className="size-12 items-center justify-center rounded-full"
    >
      <Icon name={icon} color={muted} />
    </Pressable>
  )
}
