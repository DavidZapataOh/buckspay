import { describe, expect, it } from 'vitest'
import { decodeFrame, encodeFrame, fitsAdvertisement, FrameKind } from './frame'

const conflict = new Uint8Array(227).fill(7)
const issueConflict = new Uint8Array(235).fill(8)
const beacon = new Uint8Array(9).fill(1)

describe('mesh frames', () => {
  it('round-trips each kind', () => {
    for (const [kind, payload] of [
      [FrameKind.Beacon, beacon],
      [FrameKind.SpendConflict, conflict],
      [FrameKind.IssueConflict, issueConflict],
    ] as const) {
      expect(decodeFrame(encodeFrame({ kind, payload }))).toEqual({ kind, payload })
    }
  })

  it('drops unknown kinds and wrong lengths for a kind', () => {
    expect(decodeFrame(Uint8Array.of(9, 1, 2))).toBeNull()
    expect(decodeFrame(encodeFrame({ kind: FrameKind.SpendConflict, payload: conflict }).slice(0, 100))).toBeNull()
    expect(decodeFrame(encodeFrame({ kind: FrameKind.Beacon, payload: new Uint8Array(10) }))).toBeNull()
    expect(decodeFrame(new Uint8Array(0))).toBeNull()
  })

  it('knows what fits a legacy and an extended advertisement', () => {
    const legacy = { ble: true, extended: false, maxAdvertisingBytes: 31, gattServer: true }
    const ext251 = { ...legacy, extended: true, maxAdvertisingBytes: 251 }
    const ext1650 = { ...legacy, extended: true, maxAdvertisingBytes: 1650 }
    expect(fitsAdvertisement({ kind: FrameKind.Beacon, payload: beacon }, legacy)).toBe(true)
    expect(fitsAdvertisement({ kind: FrameKind.SpendConflict, payload: conflict }, legacy)).toBe(false)
    expect(fitsAdvertisement({ kind: FrameKind.SpendConflict, payload: conflict }, ext251)).toBe(true)
    expect(fitsAdvertisement({ kind: FrameKind.IssueConflict, payload: issueConflict }, ext251)).toBe(false)
    expect(fitsAdvertisement({ kind: FrameKind.IssueConflict, payload: issueConflict }, ext1650)).toBe(true)
  })

  it('fits exactly when the service-data entry, the kind byte and the payload fill the advertisement', () => {
    const support = { ble: true, extended: false, maxAdvertisingBytes: 28, gattServer: true }
    const beaconFrame = { kind: FrameKind.Beacon, payload: beacon }
    expect(fitsAdvertisement(beaconFrame, support)).toBe(true)
    expect(fitsAdvertisement(beaconFrame, { ...support, maxAdvertisingBytes: 27 })).toBe(false)
    expect(fitsAdvertisement(beaconFrame, { ...support, ble: false })).toBe(false)
  })
})
