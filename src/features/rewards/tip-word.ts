import { type Signed, type Issue } from '../../protocol'
import type { OfflineLock } from '../../payment/preflight'
import type { NoteDb } from '../notes/db'
import type { Commitment } from '../../protocol/payword'
import { nextWord } from '../relay/tip'

/**
 * The tip of a payment: the next word of the channel of the lock it is paid from, or `null` when the payment goes
 * without one (no ticket for that lock, a bond too small for a channel, no room left or a lock that ends too soon).
 */
export function tipWord(deps: {
  db: NoteDb
  locks: readonly OfflineLock[]
  wordValue: bigint
  sign: (commitment: Commitment) => Promise<Uint8Array>
  now: () => number
}) {
  return async (issue: Signed<Issue>): Promise<Uint8Array | null> => {
    const lock = deps.locks.find(({ lockSeq }) => lockSeq === issue.message.lockSeq)
    if (!lock) return null
    const word = await nextWord(
      deps.db,
      {
        device: lock.ticket.device,
        mint: lock.mint,
        lockSeq: lock.lockSeq,
        bond: lock.bond,
        backing: lock.backing,
        lockUntil: lock.lockUntil,
      },
      { wordValue: deps.wordValue, sign: deps.sign, now: deps.now() },
    )
    return 'off' in word ? null : word.word
  }
}
