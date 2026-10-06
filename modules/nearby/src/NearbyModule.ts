import { NativeModule, requireNativeModule } from 'expo'

export type NearbySupport = { playServices: boolean; permissions: boolean; bluetooth: boolean }

export type NearbyEventPayload = {
  type: 'found' | 'lost' | 'initiated' | 'result' | 'message' | 'disconnected'
  endpointId: string
  infoHex?: string
  digits?: string
  incoming?: boolean
  ok?: boolean
}

type NearbyEvents = { onEvent(event: NearbyEventPayload): void }

/**
 * Nearby Connections with its options fixed: strategy P2P_POINT_TO_POINT, low power and the
 * non-disruptive connection type. Rejections carry one of the codes of `NearbyErrorCode`.
 */
declare class NearbyModule extends NativeModule<NearbyEvents> {
  support(): Promise<NearbySupport>
  requestPermissions(): Promise<void>
  startAdvertising(infoHex: string): Promise<void>
  stopAdvertising(): Promise<void>
  startDiscovery(): Promise<void>
  stopDiscovery(): Promise<void>
  requestConnection(endpointId: string, infoHex: string): Promise<void>
  acceptConnection(endpointId: string): Promise<void>
  rejectConnection(endpointId: string): Promise<void>
  sendBytes(endpointId: string, bytes: Uint8Array): Promise<void>
  takeMessage(endpointId: string): Promise<Uint8Array | null>
  disconnect(endpointId: string): Promise<void>
  stopAll(): Promise<void>
}

export default requireNativeModule<NearbyModule>('Nearby')
