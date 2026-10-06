import { useState } from 'react'
import { Linking, View } from 'react-native'
import { AppText } from '../../components/app-text'
import type { Band } from './app-port'
import { witnessCopy } from './copy'
import type { WitnessPolicy } from './policy'
import type { WitnessPort, WitnessRole } from './port'
import { useWitness } from './use-witness'
import { WitnessRow } from './witness-row'

/** The nearby check of one payment on a result screen: it runs while the screen is shown. */
export function NearbyCheck({
  role,
  messageId,
  policy,
  band,
  port,
}: {
  role: WitnessRole
  messageId: Uint8Array
  policy: WitnessPolicy
  band: Band
  port: WitnessPort
}) {
  const witness = useWitness({ role, messageId, policy, port, band })
  const [meaning, setMeaning] = useState(false)
  return (
    <View className="gap-2">
      <WitnessRow
        role={role}
        policy={policy}
        state={witness.state}
        onSkip={witness.skip}
        onRetry={witness.retry}
        onContinue={witness.continueAnyway}
        onMeaning={() => setMeaning((shown) => !shown)}
        onOpenSettings={() => void Linking.openSettings()}
      />
      {meaning ? (
        <AppText variant="label" tone="muted">
          {witnessCopy.meaning}
        </AppText>
      ) : null}
    </View>
  )
}
