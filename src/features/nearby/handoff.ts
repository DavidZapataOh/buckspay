import { router } from 'expo-router'
import { PairingError, type PairingFailure } from '../../transport/nearby/pairing'
import { createNearbyTransport } from '../../transport/nearby/transport'
import type { NearbyLink } from '../../transport/nearby/types'
import type { Transport } from '../../transport/types'

export type PairingRole = 'receiver' | 'payer'

type Waiting = { resolve: (transport: Transport) => void; reject: (error: PairingError) => void }

let waiting: Waiting | null = null

/** Opens the pairing screen of `role` and resolves with the transport once both people confirmed. */
export function openPairing(role: PairingRole): Promise<Transport> {
  waiting?.reject(new PairingError('Busy'))
  return new Promise<Transport>((resolve, reject) => {
    waiting = { resolve, reject: (error) => reject(error) }
    router.push(role === 'receiver' ? '/nearby/host' : '/nearby/find')
  })
}

export function completePairing(link: NearbyLink) {
  waiting?.resolve(createNearbyTransport(link))
  waiting = null
}

export function abandonPairing(reason: PairingFailure) {
  waiting?.reject(new PairingError(reason))
  waiting = null
}
