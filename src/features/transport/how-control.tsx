import { Linking, Pressable, View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import type { TransportId } from '../../transport/types'
import { hintFor, howCopy } from './copy'
import { type Offered, showHow } from './use-transports'

const fix = (id: TransportId, reason: string) => {
  if (id === 'nfc') return { label: howCopy.fix.nfc, open: () => Linking.sendIntent('android.settings.NFC_SETTINGS') }
  if (reason === 'disabled') {
    return { label: howCopy.fix.bluetooth, open: () => Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS') }
  }
  return { label: howCopy.fix.permission, open: () => Linking.openSettings() }
}

/** How the two phones talk: one segment per medium that is ready, and a line for one that can be turned on. */
export function HowControl({
  offered,
  chosen,
  onChoose,
}: {
  offered: readonly Offered[]
  chosen: TransportId
  onChoose: (id: TransportId) => void
}) {
  if (!showHow(offered)) return null
  const fixable = offered.flatMap(({ entry, availability }) => {
    const hint = availability.ready ? undefined : hintFor(entry.id, availability.reason)
    return availability.ready || !hint ? [] : [{ id: entry.id, hint, reason: availability.reason }]
  })
  return (
    <View testID="how-control" className="gap-2">
      <View accessibilityRole="tablist" className="flex-row gap-2">
        {offered
          .filter((o) => o.availability.ready)
          .map(({ entry }) => (
            <Pressable
              key={entry.id}
              testID={`how-${entry.id}`}
              accessibilityRole="tab"
              accessibilityLabel={howCopy.labels[entry.id]}
              accessibilityState={{ selected: entry.id === chosen }}
              onPress={() => onChoose(entry.id)}
              className={`min-h-12 flex-1 items-center justify-center rounded-full ${entry.id === chosen ? 'bg-secondary-container' : 'border border-outline'}`}
            >
              <AppText variant="label">{howCopy.labels[entry.id]}</AppText>
            </Pressable>
          ))}
      </View>
      {fixable.map(({ id, hint, reason }) => (
        <View key={id} className="gap-1">
          <AppText variant="label" tone="muted">
            {hint}
          </AppText>
          <Button
            testID={`how-fix-${id}`}
            variant="text"
            label={fix(id, reason).label}
            onPress={() => void fix(id, reason).open()}
          />
        </View>
      ))}
    </View>
  )
}
