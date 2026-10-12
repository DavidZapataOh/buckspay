import { i18n, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { Switch, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'

import type { MeshStartError } from './native'

export type MeshSettingsProps = {
  enabled: boolean
  problem: MeshStartError | undefined
  /** Keys other phones proved to have paid twice. */
  warnings: number
  /** Payments other phones handed this one and it posted; a count and nothing else. */
  passedOn: number
  onToggle: (on: boolean) => void
  onOpenSettings: () => void
}

const statusOf = (enabled: boolean, problem: MeshStartError | undefined) =>
  problem === 'bluetooth-off'
    ? i18n.t('mesh:status.bluetoothOff')
    : problem === 'permission-denied'
      ? i18n.t('mesh:status.permissionNeeded')
      : problem === 'unsupported'
        ? i18n.t('mesh:status.unsupported')
        : enabled
          ? i18n.t('mesh:status.on')
          : i18n.t('mesh:status.off')

/** The switch that lets this phone help nearby payments in the background, with what is wrong when it cannot. */
export function MeshSettings({ enabled, problem, warnings, passedOn, onToggle, onOpenSettings }: MeshSettingsProps) {
  const { t } = useTranslation(NAMESPACES)

  return (
    <View testID="mesh-settings" className="gap-2">
      <View className="min-h-14 flex-row items-center justify-between">
        <View className="flex-1 pr-4">
          <AppText variant="body">{t('mesh:switch')}</AppText>
          <AppText variant="body">{statusOf(enabled, problem)}</AppText>
        </View>
        <Switch testID="mesh-switch" accessibilityLabel={t('mesh:switch')} value={enabled} onValueChange={onToggle} />
      </View>
      <AppText variant="body">{t('mesh:warnings', { count: warnings })}</AppText>
      <AppText variant="body">{t('mesh:passedOn', { count: passedOn })}</AppText>
      {problem === 'bluetooth-off' ? (
        <Button variant="tonal" label={t('mesh:turnOn')} onPress={() => onToggle(true)} />
      ) : null}
      {problem === 'permission-denied' ? (
        <Button variant="tonal" label={t('mesh:openSettings')} onPress={onOpenSettings} />
      ) : null}
    </View>
  )
}
