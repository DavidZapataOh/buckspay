import type { AndroidSymbol } from 'expo-symbols'
import { Text, View } from 'react-native'
import { useThemeColors } from '../theme/use-theme-colors'
import { Icon } from './icon'

const kinds: Record<
  'done' | 'waiting' | 'problem' | 'info',
  { container: string; text: string; token: string; icon: AndroidSymbol }
> = {
  done: { container: 'bg-success-container', text: 'text-success', token: 'success', icon: 'check_circle' },
  waiting: { container: 'bg-warning-container', text: 'text-warning', token: 'warning', icon: 'schedule' },
  problem: { container: 'bg-danger-container', text: 'text-danger', token: 'danger', icon: 'error' },
  info: {
    container: 'bg-secondary-container',
    text: 'text-on-secondary-container',
    token: 'on-secondary-container',
    icon: 'info',
  },
}

/** How something stands, in an icon, a tint and a word, so colour is never the only thing that says it. */
export function Chip({ kind, label }: { kind: keyof typeof kinds; label: string }) {
  const { container, text, token, icon } = kinds[kind]
  const [color] = useThemeColors(token)
  return (
    <View className={`self-start flex-row items-center gap-1.5 rounded-full py-1 pl-2 pr-3 ${container}`}>
      <Icon name={icon} size={18} color={color} />
      <Text className={`text-sm leading-5 font-medium ${text}`}>{label}</Text>
    </View>
  )
}
