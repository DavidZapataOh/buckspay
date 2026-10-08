import { useState } from 'react'
import { Linking, Pressable, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { requestNearbyPermissions } from '../../transport/nearby/native'
import type { TransportId } from '../../transport/types'
import { hintFor, howCopy } from './copy'
import { fixable, type Offered, showHow } from './use-transports'

/** The one action that can turn a medium on; `asked` tells whether the system prompt was already shown once. */
const fix = (id: TransportId, reason: string, asked: boolean, markAsked: () => void, recheck: () => void) => {
  if (id === 'nfc') return { label: howCopy.fix.nfc, open: () => Linking.sendIntent('android.settings.NFC_SETTINGS') }
  if (reason === 'disabled') {
    return { label: howCopy.fix.bluetooth, open: () => Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS') }
  }
  if (id === 'nearby' && !asked) {
    return {
      label: howCopy.fix.allow,
      open: async () => {
        markAsked()
        await requestNearbyPermissions().catch(() => {})
        recheck()
      },
    }
  }
  return { label: howCopy.fix.permission, open: () => Linking.openSettings() }
}

/** How the two phones talk: a segment per medium, dimmed with the way to fix it when it is off but could be on. */
export function HowControl({
  offered,
  chosen,
  onChoose,
  onRecheck,
}: {
  offered: readonly Offered[]
  chosen: TransportId
  onChoose: (id: TransportId) => void
  onRecheck: () => void
}) {
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
            accessibilityLabel={howCopy.labels[entry.id]}
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
            <AppText variant="label">{howCopy.labels[entry.id]}</AppText>
          </Pressable>
        ))}
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
