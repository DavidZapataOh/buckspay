import { describe, expect, it } from 'vitest'
import { decodeBeacon, encodeBeacon, shouldAdvertiseOnline } from './beacon'

describe('beacon', () => {
  it('round-trips and is nine bytes', () => {
    const b = { online: true, clusterTag: Uint8Array.of(1, 2, 3, 4), keyId: 7, psm: 0x0081 }
    expect(encodeBeacon(b)).toHaveLength(9)
    expect([...encodeBeacon(b)]).toEqual([1, 1, 1, 2, 3, 4, 7, 0, 0x81])
    expect(decodeBeacon(encodeBeacon(b))).toEqual(b)
    expect(decodeBeacon(encodeBeacon({ ...b, online: false }))?.online).toBe(false)
    expect(decodeBeacon(new Uint8Array(8))).toBeNull()
    expect(decodeBeacon(new Uint8Array(9))).toBeNull()
  })

  it('advertises online only with validated internet and a configuration fetched in the last day', () => {
    const now = 1_800_000_000
    expect(shouldAdvertiseOnline({ validated: true }, { fetchedAt: now - 3_600 }, now)).toBe(true)
    expect(shouldAdvertiseOnline({ validated: false }, { fetchedAt: now - 3_600 }, now)).toBe(false)
    expect(shouldAdvertiseOnline({ validated: true }, { fetchedAt: now - 86_401 }, now)).toBe(false)
    expect(shouldAdvertiseOnline({ validated: true }, null, now)).toBe(false)
  })
})
