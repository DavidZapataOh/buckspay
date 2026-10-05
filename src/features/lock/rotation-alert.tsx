import { useState } from 'react'
import { View } from 'react-native'
import { AppText } from '../../components/app-text'
import { Button } from '../../components/button'
import { StatusNote } from '../../components/status-note'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { rotationNotice } from './lock-copy'
import { rotationCancelOperation } from './operations'
import { runOperation } from './run-operation'
import { useOperationContext } from './use-operation-context'
import { useRotationWatch } from './use-rotation-watch'

/**
 * Warns of a wallet rotation nobody on this phone asked for, with a one-tap cancel that Buckspay
 * pays for, or the wallet when Buckspay cannot.
 */
export function RotationAlert() {
  const ctx = useOperationContext()
  const { wallet, deviceKey } = useDeviceIdentity()
  const { alert, refresh } = useRotationWatch()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [payInstead, setPayInstead] = useState(false)
  if (!alert || !wallet || !deviceKey) return null

  async function cancel(sponsored: boolean) {
    if (!alert || !wallet || !deviceKey) return
    setBusy(true)
    setError(undefined)
    const outcome = await runOperation(
      ctx,
      rotationCancelOperation({
        programAddress: ctx.programAddress,
        wallet,
        key: deviceKey.publicKey,
        rentReceiver: alert.payer,
      }),
      sponsored,
    )
    setBusy(false)
    if (outcome.status === 'done') {
      setPayInstead(false)
      refresh()
      return
    }
    setError(outcome.error)
    setPayInstead(outcome.payInstead)
  }

  return (
    <View testID="rotation-alert" className="rounded-3xl bg-surface p-5 gap-3">
      <AppText variant="headline">A wallet change was requested</AppText>
      <AppText variant="body">{rotationNotice(alert.newWallet, alert.effectiveAt)}</AppText>
      <StatusNote testID="rotation-error" tone="danger" message={error} />
      <Button
        testID="rotation-cancel"
        variant="filled"
        label={payInstead ? 'Cancel and pay from my wallet' : 'Cancel the change'}
        busy={busy}
        onPress={() => void cancel(!payInstead && ctx.gateway !== undefined)}
      />
    </View>
  )
}
