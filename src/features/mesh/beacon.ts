import { CONFIG_FRESH } from '../../protocol/hpke'

export type Beacon = { online: boolean; clusterTag: Uint8Array; keyId: number; psm: number }

/** `version 1 ‖ flags u8 (bit 0 online) ‖ clusterTag 4 ‖ keyId u8 ‖ psm u16`. */
export function encodeBeacon({ online, clusterTag, keyId, psm }: Beacon): Uint8Array {
  const out = new Uint8Array(9)
  out[0] = 1
  out[1] = online ? 1 : 0
  out.set(clusterTag.subarray(0, 4), 2)
  out[6] = keyId
  new DataView(out.buffer).setUint16(7, psm)
  return out
}

/** `null` for a payload that is not a version 1 beacon. */
export function decodeBeacon(payload: Uint8Array): Beacon | null {
  if (payload.length !== 9 || payload[0] !== 1) return null
  return {
    online: (payload[1] & 1) === 1,
    clusterTag: payload.slice(2, 6),
    keyId: payload[6],
    psm: new DataView(payload.buffer, payload.byteOffset).getUint16(7),
  }
}

/** A phone says it is online only with validated internet and a gateway configuration fetched in the last day. */
export function shouldAdvertiseOnline(
  network: { validated: boolean },
  config: { fetchedAt: number } | null,
  now: number,
): boolean {
  return network.validated && config !== null && now - config.fetchedAt <= CONFIG_FRESH
}
