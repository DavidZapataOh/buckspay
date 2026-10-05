import { TextInput, View } from 'react-native'
import { useThemeColors } from '../theme/use-theme-colors'
import { AppText } from './app-text'

export type TextFieldProps = {
  label: string
  value: string
  onChangeText: (text: string) => void
  keyboardType?: 'numeric' | 'decimal-pad'
  testID?: string
}

/** A labelled single-line field with a Material outline. */
export function TextField({ label, value, onChangeText, keyboardType, testID }: TextFieldProps) {
  const [muted] = useThemeColors('muted')
  return (
    <View className="gap-1">
      <AppText variant="label" tone="muted">
        {label}
      </AppText>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        selectionColor={muted}
        className="min-h-12 rounded-xl border border-outline px-4 text-base text-foreground"
      />
    </View>
  )
}
