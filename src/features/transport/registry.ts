import { openPairing, type PairingRole } from '../nearby/handoff'
import { nearbyNative } from '../../transport/nearby/native'
import { nearbyAvailability } from '../../transport/nearby/transport'
import { nfcNative } from '../../transport/nfc/native'
import { createNfcTransport, nfcAvailability } from '../../transport/nfc/transport'
import type { NfcRole } from '../../transport/nfc/types'
import type { Availability, Transport, TransportId } from '../../transport/types'
import { howCopy } from './copy'
import { meshPause, meshResume } from './mesh-yield'

export type { PairingRole }

/** A way to move messages, as the pay and receive screens offer it. */
export type TransportEntry = {
  id: TransportId
  label: string
  check(): Promise<Availability>
  /** Resolves with a transport that is ready to send and receive; pairing screens open first where the medium needs them. */
  start(role: PairingRole): Promise<Transport>
}

/** The QR surface belongs to the screen, so the entry hands out the transport of the screen's session. */
export function qrEntry(session: { transport: Transport }): TransportEntry {
  return {
    id: 'qr',
    label: howCopy.labels.qr,
    check: async () => ({ ready: true }),
    start: async () => session.transport,
  }
}

/** The receiver's phone is the card the payer's reader taps. */
export const nfcRoleFor = (role: PairingRole): NfcRole => (role === 'receiver' ? 'card' : 'reader')

export const nfcEntry: TransportEntry = {
  id: 'nfc',
  label: howCopy.labels.nfc,
  check: async () => nfcAvailability(await nfcNative.support()),
  start: async (role) => createNfcTransport(nfcNative, nfcRoleFor(role)),
}

export function createNearbyEntry(open: (role: PairingRole) => Promise<Transport>): TransportEntry {
  return {
    id: 'nearby',
    label: howCopy.labels.nearby,
    check: async () => nearbyAvailability(await nearbyNative.support()),
    async start(role) {
      await meshPause()
      try {
        const transport = await open(role)
        const close = transport.close.bind(transport)
        transport.close = async () => {
          try {
            await close()
          } finally {
            await meshResume()
          }
        }
        return transport
      } catch (error) {
        await meshResume()
        throw error
      }
    },
  }
}

export const nearbyEntry = createNearbyEntry(openPairing)
