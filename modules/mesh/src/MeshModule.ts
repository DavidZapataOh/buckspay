import { NativeModule, requireNativeModule } from 'expo'

export type MeshSupport = { ble: boolean; extended: boolean; maxAdvertisingBytes: number; gattServer: boolean }
export type MeshStatus = {
  enabled: boolean
  running: boolean
  paused: boolean
  scanStartsLast30s: number
  frames: number
}

/**
 * The background mesh: a foreground service that scans for and advertises small frames. `start` rejects with
 * `permission-denied`, `bluetooth-off` or `unsupported`; `advertise` with `not-running`, `frame-too-large` or
 * `too-many-frames`.
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
}

export default requireNativeModule<MeshModule>('Mesh')
