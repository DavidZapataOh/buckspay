import AsyncStorage from '@react-native-async-storage/async-storage'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { address, getAddressEncoder } from '@solana/kit'
import type { Attester } from '../../protocol'
import type { TrustedAttester } from './registry'

const STORE = 'attesters:v1'

type Stored = Omit<Attester, 'authority' | 'mint' | 'key' | 'prevKey' | 'revoked' | 'stake' | 'relied'> & {
  authority: string
  mint: string
  key: string
  prevKey: string
  revoked: [string, string]
  stake: string
}

const toStored = (attester: Attester): Stored => ({
  id: attester.id,
  authority: bytesToHex(attester.authority),
  mint: bytesToHex(attester.mint),
  stake: attester.stake.toString(),
  key: bytesToHex(attester.key),
  prevKey: bytesToHex(attester.prevKey),
  prevTrustedUntil: attester.prevTrustedUntil,
  revoked: [bytesToHex(attester.revoked[0]), bytesToHex(attester.revoked[1])],
  syncedAt: attester.syncedAt,
  active: attester.active,
})

const fromStored = (stored: Stored): Attester => ({
  ...stored,
  authority: hexToBytes(stored.authority),
  mint: hexToBytes(stored.mint),
  stake: BigInt(stored.stake),
  key: hexToBytes(stored.key),
  prevKey: hexToBytes(stored.prevKey),
  revoked: [hexToBytes(stored.revoked[0]), hexToBytes(stored.revoked[1])],
  relied: 0n,
})

/** Keeps the attesters the wallet believes, as of the last sync. What the wallet relies on is read from its notes. */
export const saveRegistry = (attesters: readonly Attester[]) =>
  AsyncStorage.setItem(STORE, JSON.stringify(attesters.map(toStored)))

/** The attesters believed at the last sync, none when nothing was saved or it cannot be read. */
export async function loadRegistry(): Promise<Attester[]> {
  try {
    const stored: unknown = JSON.parse((await AsyncStorage.getItem(STORE)) ?? '[]')
    return Array.isArray(stored) ? (stored as Stored[]).map(fromStored) : []
  } catch {
    return []
  }
}

/**
 * The attesters a build pins, from its `EXPO_PUBLIC_ATTESTERS` setting: a JSON list of
 * `{ id, authority, mint }` with addresses in base58. Nothing else is trusted.
 */
export function parseTrusted(setting: string | undefined): TrustedAttester[] {
  if (!setting) return []
  const list: unknown = JSON.parse(setting)
  if (!Array.isArray(list)) throw new Error('EXPO_PUBLIC_ATTESTERS must be a list')
  const encoder = getAddressEncoder()
  return list.map((entry: { id?: unknown; authority?: unknown; mint?: unknown }) => {
    const { id, authority, mint } = entry
    if (!Number.isInteger(id) || (id as number) < 0 || (id as number) > 0xffff) throw new Error('Attester id')
    if (typeof authority !== 'string' || typeof mint !== 'string') throw new Error('Attester authority or mint')
    return {
      id: id as number,
      authority: Uint8Array.from(encoder.encode(address(authority))),
      mint: Uint8Array.from(encoder.encode(address(mint))),
    }
  })
}
