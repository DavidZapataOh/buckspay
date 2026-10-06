import { equalBytes } from '@noble/curves/utils.js'
import type { Beacon } from '../mesh/beacon'
import { type Channel, openHop } from './hop'
import type { RelayAnswer, SealedRelay } from './seal'

/** A thing the radio saw: where from, how strong, and how many seconds ago. */
export type Seen<T> = { value: T; address: string; rssi: number; ageSeconds: number }

/** How the app reaches a phone over Bluetooth L2CAP; `modules/mesh` implements it. */
export interface L2capLink {
  /** Opens the server this phone is reached on and returns its PSM. */
  listen(): Promise<number>
  connect(address: string, psm: number): Promise<Channel>
}

/** Seconds a beacon still counts as a phone in range. */
export const BEACON_TTL = 60
export const COPIES = 3
const STORED_TIMEOUT_MS = 5_000
const ANSWER_TIMEOUT_MS = 15_000

/** Up to `max` online beacons of this cluster seen in the last minute: the strongest, then one at random among the rest. */
export function chooseBeacons(
  clusterTag: Uint8Array,
  beacons: readonly Seen<Beacon>[],
  max: number,
  random: () => number = Math.random,
): Seen<Beacon>[] {
  const usable = beacons
    .filter((b) => b.value.online && equalBytes(b.value.clusterTag, clusterTag) && b.ageSeconds <= BEACON_TTL)
    .sort((a, b) => b.rssi - a.rssi)
  const strongest = usable.slice(0, Math.max(0, max - 1))
  const rest = usable.slice(strongest.length)
  // A strong fake radio cannot take every copy: the last one is any of the others.
  const lucky = rest.length > 0 && max > 0 ? [rest[Math.floor(random() * rest.length)]] : []
  return [...strongest, ...lucky].slice(0, max)
}

async function toRelayer(sealed: SealedRelay, target: Seen<Beacon>, link: L2capLink) {
  const channel = await link.connect(target.address, target.value.psm)
  try {
    const hop = await openHop(channel, 'initiator')
    await hop.send(sealed.blob)
    const stored = (await hop.receive(STORED_TIMEOUT_MS))[0] === 0x01
    if (!stored) return { stored: false, answer: null }
    const answer = await hop.receive(ANSWER_TIMEOUT_MS).then(
      (response) => sealed.openResponse(response),
      () => null,
    )
    return { stored: true, answer }
  } catch {
    return { stored: false, answer: null }
  } finally {
    channel.close()
  }
}

/** Hands the sealed settlement to up to `max` beacons and reports how many kept it and the first answer that opens. */
export async function handOff(
  sealed: SealedRelay,
  beacons: readonly Seen<Beacon>[],
  link: L2capLink,
  max: number,
  random?: () => number,
): Promise<{ stored: number; answer: RelayAnswer | null }> {
  const results = await Promise.all(
    chooseBeacons(sealed.clusterTag, beacons, max, random).map((target) => toRelayer(sealed, target, link)),
  )
  return {
    stored: results.filter((result) => result.stored).length,
    answer: results.find((result) => result.answer)?.answer ?? null,
  }
}
