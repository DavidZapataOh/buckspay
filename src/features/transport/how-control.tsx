import type { AndroidSymbol } from 'expo-symbols'
import { i18n, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { Linking, Pressable, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { Icon } from '../../components/icon'
import { Info } from '../../components/info'
import { feedback } from '../../feedback'
import { requestNearbyPermissions } from '../../transport/nearby/native'
import type { TransportId } from '../../transport/types'
import { useThemeColors } from '../../theme/use-theme-colors'
import { hintFor } from './copy'
import { fixable, type Offered, showHow } from './use-transports'

const ICONS: Record<TransportId, AndroidSymbol> = { qr: 'qr_code_2', nfc: 'nfc', nearby: 'wifi_tethering' }

/** The one action that can turn a medium on; `asked` tells whether the system prompt was already shown once. */
const fix = (id: TransportId, reason: string, asked: boolean, markAsked: () => void, recheck: () => void) => {
  if (id === 'nfc')
    return { label: i18n.t('transport:fix.nfc'), open: () => Linking.sendIntent('android.settings.NFC_SETTINGS') }
  if (reason === 'disabled') {
    return {
      label: i18n.t('transport:fix.bluetooth'),
      open: () => Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS'),
    }
  }
  if (id === 'nearby' && !asked) {
    return {
      label: i18n.t('transport:fix.allow'),
      open: async () => {
        markAsked()
        await requestNearbyPermissions().catch(() => {})
        recheck()
      },
    }
  }
  return { label: i18n.t('transport:fix.permission'), open: () => Linking.openSettings() }
}

/** How the two phones talk: a segment per medium with its icon, dimmed with the way to fix it when it is off but could be on. */
export function HowControl({
  offered,
  chosen,
  onChoose,
  onRecheck,
  role,
}: {
  offered: readonly Offered[]
  chosen: TransportId
  /** Who is using it: the help says what each side does. */
  role: 'pay' | 'receive'
  onChoose: (id: TransportId) => void
  onRecheck: () => void
}) {
  const { t } = useTranslation(NAMESPACES)
  const [primary, muted] = useThemeColors('on-secondary-container', 'muted')

  const [asked, setAsked] = useState(false)
  if (!showHow(offered)) return null
  const shown = offered.filter((o) => o.availability.ready || fixable(o))
  return (
    <View testID="how-control" className="gap-2">
      <View className="flex-row items-center gap-2">
        <View accessibilityRole="tablist" className="flex-1 flex-row gap-2">
          {shown.map(({ entry, availability }) => {
            const selected = availability.ready && entry.id === chosen
            return (
              <Pressable
                key={entry.id}
                testID={`how-${entry.id}`}
                accessibilityRole="tab"
                accessibilityLabel={t(`transport:labels.${entry.id}`)}
                accessibilityState={{ selected, disabled: !availability.ready }}
                onPress={() => {
                  if (!availability.ready) return
                  if (entry.id !== chosen) feedback.cue('tap')
                  onChoose(entry.id)
                }}
                className={`min-h-14 flex-1 items-center justify-center gap-0.5 rounded-2xl ${
                  !availability.ready
                    ? 'border border-outline bg-disabled'
                    : selected
                      ? 'bg-secondary-container'
                      : 'border border-outline bg-surface'
                }`}
              >
                <Icon name={ICONS[entry.id]} size={22} color={selected ? primary : muted} />
                <AppText variant="label" tone={availability.ready ? 'default' : 'muted'}>
                  {t(`transport:labels.${entry.id}`)}
                </AppText>
              </Pressable>
            )
          })}
        </View>
        <Info title={t('transport:howTitle')} lines={[t(`transport:modeHelp.${role}.${chosen}`)]} />
      </View>
      {shown.flatMap(({ entry, availability }) => {
        if (availability.ready) return []
        const action = fix(entry.id, availability.reason, asked, () => setAsked(true), onRecheck)
        return [
          <View key={entry.id} className="gap-1">
            <AppText variant="label" tone="muted">
              {hintFor(entry.id, availability.reason)}
            </AppText>
            <Button
              testID={`how-fix-${entry.id}`}
              variant="text"
              label={action.label}
              onPress={() => void action.open()}
            />
          </View>,
        ]
      })}
    </View>
  )
}
