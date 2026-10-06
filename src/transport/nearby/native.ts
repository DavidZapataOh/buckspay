import Nearby, { type NearbyEventPayload } from '../../../modules/nearby/src/NearbyModule'
import { NearbyError, type NearbyErrorCode, type NearbyEvent, type NearbyNative } from './types'

const CODES: readonly string[] = ['RadioOff', 'PermissionMissing', 'Unsupported', 'AlreadyActive', 'Failed']

async function call<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    throw new NearbyError((CODES.includes(code) ? code : 'Failed') as NearbyErrorCode)
  }
}

function toEvent(event: NearbyEventPayload): NearbyEvent {
  const { endpointId } = event
  switch (event.type) {
    case 'found':
      return { type: 'found', endpointId, infoHex: event.infoHex ?? '' }
    case 'initiated':
      return {
        type: 'initiated',
        endpointId,
        digits: event.digits ?? '',
        incoming: event.incoming ?? false,
        infoHex: event.infoHex ?? '',
      }
    case 'result':
      return { type: 'result', endpointId, ok: event.ok ?? false }
    default:
      return { type: event.type, endpointId }
  }
}

/** The only place that touches the native module. */
export const nearbyNative: NearbyNative = {
  support: () => call(Nearby.support()),
  startAdvertising: (infoHex) => call(Nearby.startAdvertising(infoHex)),
  stopAdvertising: () => call(Nearby.stopAdvertising()),
  startDiscovery: () => call(Nearby.startDiscovery()),
  stopDiscovery: () => call(Nearby.stopDiscovery()),
  requestConnection: (endpointId, infoHex) => call(Nearby.requestConnection(endpointId, infoHex)),
  acceptConnection: (endpointId) => call(Nearby.acceptConnection(endpointId)),
  rejectConnection: (endpointId) => call(Nearby.rejectConnection(endpointId)),
  sendBytes: (endpointId, bytes) => call(Nearby.sendBytes(endpointId, bytes)),
  takeMessage: (endpointId) => call(Nearby.takeMessage(endpointId)),
  disconnect: (endpointId) => call(Nearby.disconnect(endpointId)),
  stopAll: () => call(Nearby.stopAll()),
  addListener: (listener) => {
    const subscription = Nearby.addListener('onEvent', (event) => listener(toEvent(event)))
    return () => subscription.remove()
  },
}

/** One system prompt for everything this Android version needs; check `support()` afterwards. */
export const requestNearbyPermissions = () => call(Nearby.requestPermissions())
