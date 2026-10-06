import { beforeEach, describe, expect, it } from 'vitest'
import { encodeBeacon } from '../mesh/beacon'
import { beaconsSeen, forgetBeacons, recordBeacon } from './beacons'

const payload = (psm: number) => encodeBeacon({ online: true, clusterTag: Uint8Array.of(1, 2, 3, 4), keyId: 7, psm })
beforeEach(forgetBeacons)

describe('beacons seen', () => {
  it('keeps the latest beacon of each address with its age and forgets what is old', () => {
    recordBeacon('a', payload(0x81), -60, 100)
    recordBeacon('a', payload(0x83), -55, 130)
    recordBeacon('b', payload(0x85), -70, 140)
    expect(beaconsSeen(150).map((seen) => [seen.address, seen.value.psm, seen.rssi, seen.ageSeconds])).toEqual([
      ['a', 0x83, -55, 20],
      ['b', 0x85, -70, 10],
    ])
    expect(beaconsSeen(255).map((seen) => seen.address)).toEqual(['b'])
  })

  it('ignores a payload that is not a beacon', () => {
    recordBeacon('a', new Uint8Array(9), -60, 100)
    expect(beaconsSeen(100)).toEqual([])
  })
})
