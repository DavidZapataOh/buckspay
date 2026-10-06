import { openPairing, type PairingRole } from '../nearby/handoff'
import { nearbyNative } from '../../transport/nearby/native'
import { nearbyAvailability } from '../../transport/nearby/transport'
import type { Availability, Transport, TransportId } from '../../transport/types'

/** A way to move messages, as the pay and receive screens offer it. */
export type TransportEntry = {
  id: TransportId
  label: string
  check(): Promise<Availability>
  /** Resolves with a transport that is ready to send and receive; pairing screens open first where the medium needs them. */
  start(role: PairingRole): Promise<Transport>
}

export const nearbyEntry: TransportEntry = {
  id: 'nearby',
  label: 'Nearby',
  check: async () => nearbyAvailability(await nearbyNative.support()),
  start: openPairing,
}
