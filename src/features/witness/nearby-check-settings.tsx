import { Switch, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { TextField } from '../../components/text-field'
import { witnessCopy } from './copy'

export type NearbyCheckSettingsProps = {
  answer: boolean
  ask: boolean
  audible: boolean
  /** The amount from which the receiver waits for the check, in whole units; empty for never. */
  requireFrom: string
  onAnswer: (value: boolean) => void
  onAsk: (value: boolean) => void
  onAudible: (value: boolean) => void
  onRequireFrom: (value: string) => void
}

function SwitchRow({
  label,
  value,
  onChange,
  testID,
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
  testID: string
}) {
  return (
    <View className="min-h-14 flex-row items-center justify-between">
      <AppText variant="body">{label}</AppText>
      <Switch testID={testID} accessibilityLabel={label} value={value} onValueChange={onChange} />
    </View>
  )
}

/** The switches of the nearby check: who answers, who asks, from what amount to wait, and which sound. */
export function NearbyCheckSettings(props: NearbyCheckSettingsProps) {
  const copy = witnessCopy.settings
  return (
    <View testID="nearby-check-settings" className="gap-2">
      <AppText variant="title">{copy.title}</AppText>
      <SwitchRow testID="nearby-answer" label={copy.answer} value={props.answer} onChange={props.onAnswer} />
      <SwitchRow testID="nearby-ask" label={copy.ask} value={props.ask} onChange={props.onAsk} />
      <TextField
        testID="nearby-require-from"
        label={copy.requireFrom}
        value={props.requireFrom}
        onChangeText={props.onRequireFrom}
        keyboardType="decimal-pad"
      />
      <SwitchRow testID="nearby-audible" label={copy.audible} value={props.audible} onChange={props.onAudible} />
      <AppText variant="label" tone="muted">
        {copy.footnote}
      </AppText>
    </View>
  )
}
