import { type Beacon, decodeBeacon } from '../mesh/beacon'
import type { Seen } from './handoff'

type Entry = { beacon: Beacon; rssi: number; at: number }

/** Seconds a beacon is remembered: longer than a hand-off wants it, so the list does not flicker. */
const KEEP = 120

const entries = new Map<string, Entry>()

/** Notes a beacon the radio saw; a payload that is not a beacon is ignored. */
export function recordBeacon(address: string, payload: Uint8Array, rssi: number, now: number): void {
  const beacon = decodeBeacon(payload)
  if (beacon) entries.set(address, { beacon, rssi, at: now })
}

/** The beacons seen lately, with how long ago, for `handOff` to choose among. */
export function beaconsSeen(now: number): Seen<Beacon>[] {
  for (const [address, entry] of entries) if (now - entry.at > KEEP) entries.delete(address)
  return [...entries].map(([address, entry]) => ({
    value: entry.beacon,
    address,
    rssi: entry.rssi,
    ageSeconds: now - entry.at,
  }))
}

export const forgetBeacons = () => entries.clear()
