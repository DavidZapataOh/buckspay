import { NativeModule, requireNativeModule } from 'expo'

export type MeshSupport = { ble: boolean; extended: boolean; maxAdvertisingBytes: number; gattServer: boolean }
export type MeshStatus = {
  enabled: boolean
  running: boolean
  paused: boolean
  scanStartsLast30s: number
  frames: number
  /** Whether Android validated the current internet connection. */
  validated: boolean
  /** The PSM of the L2CAP server, or 0 when none is open. */
  psm: number
}

/**
 * The background mesh: a foreground service that scans for and advertises small frames. `start` rejects with
 * `permission-denied`, `bluetooth-off` or `unsupported`; `advertise` with `not-running`, `frame-too-large` or
 * `too-many-frames`. The L2CAP calls reject with `not-running`, `connect-failed`, `timeout` or `closed`.
 */
declare class MeshModule extends NativeModule {
  support(): Promise<MeshSupport>
  start(): Promise<void>
  stop(): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  advertise(frameId: string, frame: Uint8Array, ttlSeconds: number): Promise<void>
  withdraw(frameId: string): Promise<void>
  status(): Promise<MeshStatus>
  /** Advertises that this phone can take a payment to the internet, on the PSM of an L2CAP server it opens. */
  setBeacon(online: boolean, clusterTag: Uint8Array, keyId: number): Promise<void>
  clearBeacon(): Promise<void>
  l2capConnect(address: string, psm: number): Promise<number>
  l2capRead(channel: number, length: number, timeoutMs: number): Promise<Uint8Array>
  l2capWrite(channel: number, bytes: Uint8Array): Promise<void>
  l2capClose(channel: number): Promise<void>
}

export default requireNativeModule<MeshModule>('Mesh')
