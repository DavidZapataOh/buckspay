import { Text, TextInput, View } from 'react-native'
import { useThemeColors } from '../theme/use-theme-colors'

/** Where an amount is typed: the number as big as it will be read, the unit small beside it. */
export function AmountField({
  label,
  symbol,
  value,
  onChangeText,
  testID,
}: {
  label: string
  symbol: string
  value: string
  onChangeText: (text: string) => void
  testID?: string
}) {
  const [muted] = useThemeColors('muted')
  return (
    <View className="flex-row items-baseline justify-center gap-2 py-4">
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        keyboardType="decimal-pad"
        placeholder="0"
        placeholderTextColor={muted}
        selectionColor={muted}
        className="min-w-20 text-center text-6xl font-bold text-strong"
      />
      <Text className="text-xl leading-7 font-medium text-muted">{symbol}</Text>
    </View>
  )
}
