import AsyncStorage from '@react-native-async-storage/async-storage'
import { bytesToHex } from '@noble/hashes/utils.js'
import { ACTIVE_PROFILE } from '../../protocol/active-profile'

/** Keyed by the program too, so a build for another cluster never reads these. */
const storeKey = (key: Uint8Array) => `locks:active-v1:${ACTIVE_PROFILE.programId}:${bytesToHex(key)}`

/**
 * Remembers which locks of this device key were active at the last read of the chain, so that paying without
 * internet does not wait for a read. A lock withdrawn while the phone was offline cannot be known here: its ticket
 * runs out within a day and the receiver checks the ticket and the bond.
 */
export async function saveActiveLocks(key: Uint8Array, active: readonly number[]) {
  await AsyncStorage.setItem(storeKey(key), JSON.stringify(active))
}

export async function loadActiveLocks(key: Uint8Array): Promise<number[]> {
  try {
    const stored: unknown = JSON.parse((await AsyncStorage.getItem(storeKey(key))) ?? '[]')
    return Array.isArray(stored) ? stored.filter((seq): seq is number => Number.isInteger(seq)) : []
  } catch {
    return []
  }
}
