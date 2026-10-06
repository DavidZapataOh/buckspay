import AsyncStorage from '@react-native-async-storage/async-storage'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { Owner } from '../../protocol'
import type { NoteChain } from './chain'

/**
 * The people who held the chain's note before `me`, other than its issuer, counted once per key; null
 * when there are none and settling in the clear publishes nobody else's key.
 */
export function needsClearNotice(chain: NoteChain, me: Uint8Array): { holders: number } | null {
  const keys = new Set<string>()
  const add = (owner: Owner) => owner.type === 'device' && keys.add(bytesToHex(owner.key))
  add(chain.issue.message.owner)
  for (const { message } of chain.spends) {
    const { outputs } = message
    if (outputs.type === 'one') add(outputs.owner)
    else {
      add(outputs.owner0)
      add(outputs.owner1)
    }
  }
  keys.delete(bytesToHex(me))
  keys.delete(bytesToHex(chain.issue.message.issuer))
  return keys.size === 0 ? null : { holders: keys.size }
}

const key = (outputId: string) => `settlement:notice-v1:${outputId}`

/** Whether the person has read what settling this note in the clear publishes and said to go on. */
export async function isNoticeShown(outputId: string): Promise<boolean> {
  return (await AsyncStorage.getItem(key(outputId))) === '1'
}

export const markNoticeShown = (outputId: string) => AsyncStorage.setItem(key(outputId), '1')
