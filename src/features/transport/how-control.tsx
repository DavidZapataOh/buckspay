import { i18n, NAMESPACES } from '../../i18n'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import { Linking, Pressable, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { requestNearbyPermissions } from '../../transport/nearby/native'
import type { TransportId } from '../../transport/types'
import { hintFor } from './copy'
import { fixable, type Offered, showHow } from './use-transports'

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

/** How the two phones talk: a segment per medium, dimmed with the way to fix it when it is off but could be on. */
export function HowControl({
  offered,
  chosen,
  onChoose,
  onRecheck,
  role,
}: {
  offered: readonly Offered[]
  chosen: TransportId
  /** Who is using it: the help line says what each side does. */
  role: 'pay' | 'receive'
  onChoose: (id: TransportId) => void
  onRecheck: () => void
}) {
  const { t } = useTranslation(NAMESPACES)

  const [asked, setAsked] = useState(false)
  if (!showHow(offered)) return null
  const shown = offered.filter((o) => o.availability.ready || fixable(o))
  return (
    <View testID="how-control" className="gap-2">
      <View accessibilityRole="tablist" className="flex-row gap-2">
        {shown.map(({ entry, availability }) => (
          <Pressable
            key={entry.id}
            testID={`how-${entry.id}`}
            accessibilityRole="tab"
            accessibilityLabel={t(`transport:labels.${entry.id}`)}
            accessibilityState={{ selected: availability.ready && entry.id === chosen, disabled: !availability.ready }}
            onPress={() => availability.ready && onChoose(entry.id)}
            className={`min-h-12 flex-1 items-center justify-center rounded-full ${
              !availability.ready
                ? 'border border-outline opacity-40'
                : entry.id === chosen
                  ? 'bg-secondary-container'
                  : 'border border-outline'
            }`}
          >
            <AppText variant="label">{t(`transport:labels.${entry.id}`)}</AppText>
          </Pressable>
        ))}
      </View>
      <AppText variant="label" tone="muted">
        {t(`transport:modeHelp.${role}.${chosen}`)}
      </AppText>
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
