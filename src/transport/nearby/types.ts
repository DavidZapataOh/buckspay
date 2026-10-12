export type NearbySupport = {
  /** Google Play services present and new enough for the Nearby client. */
  playServices: boolean
  /** Every runtime permission this Android version needs is granted. */
  permissions: boolean
  /** Bluetooth is on: Nearby will not turn it on (late-2026 behaviour). */
  bluetooth: boolean
}

export type NearbyEvent =
  | { type: 'found'; endpointId: string; infoHex: string }
  | { type: 'lost'; endpointId: string }
  | { type: 'initiated'; endpointId: string; digits: string; incoming: boolean; infoHex: string }
  | { type: 'result'; endpointId: string; ok: boolean }
  | { type: 'message'; endpointId: string }
  | { type: 'disconnected'; endpointId: string }

/** `pay` is the one-to-one payment link; `group` is the one-to-many hub; `groupSequential` is the hub's one-at-a-time fallback. */
export type NearbyMode = 'pay' | 'group' | 'groupSequential'

export type NearbyErrorCode = 'RadioOff' | 'PermissionMissing' | 'Unsupported' | 'AlreadyActive' | 'Failed'

export class NearbyError extends Error {
  constructor(readonly code: NearbyErrorCode) {
    super(code)
    this.name = 'NearbyError'
  }
}

/**
 * The native module, as the JavaScript side sees it. The strategy follows the mode (`pay` and `groupSequential` use
 * P2P_POINT_TO_POINT, `group` uses P2P_STAR); low power and the non-disruptive connection type are fixed inside it.
 */
export interface NearbyNative {
  support(): Promise<NearbySupport>
  startAdvertising(infoHex: string, mode?: NearbyMode): Promise<void>
  stopAdvertising(): Promise<void>
  startDiscovery(mode?: NearbyMode): Promise<void>
  stopDiscovery(): Promise<void>
  requestConnection(endpointId: string, infoHex: string): Promise<void>
  acceptConnection(endpointId: string): Promise<void>
  rejectConnection(endpointId: string): Promise<void>
  /** Resolves once the peer acknowledged the payload; rejects with NearbyError('Failed') otherwise. */
  sendBytes(endpointId: string, bytes: Uint8Array): Promise<void>
  /** The oldest received payload of the endpoint, or null; announced by a `message` event. */
  takeMessage(endpointId: string): Promise<Uint8Array | null>
  disconnect(endpointId: string): Promise<void>
  stopAll(): Promise<void>
  addListener(listener: (event: NearbyEvent) => void): () => void
}

/** An established, accepted connection to one other phone. */
export type NearbyLink = { endpointId: string; native: NearbyNative; role: NearbyRole }

/** The receiver shows the request and the payer answers it. */
export type NearbyRole = 'receiver' | 'payer'
