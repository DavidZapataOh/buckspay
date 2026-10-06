import { Switch, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { meshCopy } from './copy'
import type { MeshStartError } from './native'

export type MeshSettingsProps = {
  enabled: boolean
  problem: MeshStartError | undefined
  onToggle: (on: boolean) => void
  onOpenSettings: () => void
}

const statusOf = (enabled: boolean, problem: MeshStartError | undefined) =>
  problem === 'bluetooth-off'
    ? meshCopy.status.bluetoothOff
    : problem === 'permission-denied'
      ? meshCopy.status.permissionNeeded
      : problem === 'unsupported'
        ? meshCopy.status.unsupported
        : enabled
          ? meshCopy.status.on
          : meshCopy.status.off

/** The switch that lets this phone help nearby payments in the background, with what is wrong when it cannot. */
export function MeshSettings({ enabled, problem, onToggle, onOpenSettings }: MeshSettingsProps) {
  return (
    <View testID="mesh-settings" className="gap-2">
      <View className="min-h-14 flex-row items-center justify-between">
        <View className="flex-1 pr-4">
          <AppText variant="body">{meshCopy.switch}</AppText>
          <AppText variant="body">{statusOf(enabled, problem)}</AppText>
        </View>
        <Switch testID="mesh-switch" accessibilityLabel={meshCopy.switch} value={enabled} onValueChange={onToggle} />
      </View>
      {problem === 'bluetooth-off' ? (
        <Button variant="tonal" label={meshCopy.turnOn} onPress={() => onToggle(true)} />
      ) : null}
      {problem === 'permission-denied' ? (
        <Button variant="tonal" label={meshCopy.openSettings} onPress={onOpenSettings} />
      ) : null}
    </View>
  )
}
