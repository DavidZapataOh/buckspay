import { address, getAddressEncoder } from '@solana/kit'
import { useState } from 'react'
import { Screen } from '../../components/screen'
import { useDeviceIdentity } from '../../features/identity/use-device-identity'
import { newEvent, RunEvent } from '../../features/event/run-event'
import type { PointPairing } from '../../features/event/payloads'
import { savePairing } from '../../features/event/store'
import { usePayFlow } from '../../features/pay/use-pay-flow'
import { nowSeconds, usePayments } from '../../features/payment/payments-provider'

export default function RunEventScreen() {
  const { db } = usePayments()
  const { device, deviceKey } = useDeviceIdentity()
  const flow = usePayFlow()
  const [event, setEvent] = useState<PointPairing | null>(null)
  const [error, setError] = useState<string>()

  async function create(name: string, hours: number) {
    if (!db || !device || !deviceKey) {
      setError('Connect a wallet and set up payments first.')
      return
    }
    const created = newEvent({
      name,
      hours,
      authority: Uint8Array.from(getAddressEncoder().encode(address(device.wallet))),
      issuer: deviceKey.publicKey,
      now: nowSeconds(),
    })
    await savePairing(db, 'organiser', created)
    await flow.reloadEvents()
    setEvent(created)
  }

  return (
    <Screen testID="run-screen">
      <RunEvent event={event} error={error} onCreate={(name, hours) => void create(name, hours)} />
    </Screen>
  )
}
