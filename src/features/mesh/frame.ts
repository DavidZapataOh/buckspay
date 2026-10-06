import type { MeshSupport } from './native'

export const FrameKind = { Beacon: 1, SpendConflict: 2, IssueConflict: 3 } as const
export type Frame = { kind: (typeof FrameKind)[keyof typeof FrameKind]; payload: Uint8Array }

/** The service-data UUID frames are advertised under; the Kotlin module holds the same value. */
export const MESH_SERVICE_UUID = '7c2f1d3a-5b8e-4f60-9a47-2e6d0b9c81f5'

const PAYLOAD_LENGTH: Record<Frame['kind'], number> = { 1: 9, 2: 227, 3: 235 }
/** Length, type and 128-bit UUID of the service-data entry that carries a frame. */
const SERVICE_DATA_OVERHEAD = 18

export function encodeFrame({ kind, payload }: Frame): Uint8Array {
  const bytes = new Uint8Array(1 + payload.length)
  bytes[0] = kind
  bytes.set(payload, 1)
  return bytes
}

/** `null` for an unknown kind or a payload of the wrong length for its kind. */
export function decodeFrame(bytes: Uint8Array): Frame | null {
  const kind = bytes[0] as Frame['kind'] | undefined
  if (kind === undefined || !(kind in PAYLOAD_LENGTH) || bytes.length - 1 !== PAYLOAD_LENGTH[kind]) return null
  return { kind, payload: bytes.slice(1) }
}

export function fitsAdvertisement(frame: Frame, support: MeshSupport): boolean {
  return support.ble && SERVICE_DATA_OVERHEAD + 1 + frame.payload.length <= support.maxAdvertisingBytes
}
