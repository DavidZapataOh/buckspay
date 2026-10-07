import { decodeCommitment } from '../../protocol/payword'
import type { NoteDb } from '../notes/db'
import type { RewardRecord, WordRecord } from './state'

/** The words this phone holds as a relayer, each with the fee its commitment pays. */
export async function wordRecords(db: NoteDb): Promise<WordRecord[]> {
  const rows = await db.all<{ state: WordRecord['state']; commitment: Uint8Array }>(
    'SELECT state, commitment FROM relay_words ORDER BY received_at DESC, channel, idx',
  )
  return rows.map(({ state, commitment }) => ({
    kind: 'word',
    state,
    value: decodeCommitment(commitment).wordValue,
  }))
}

/** Every record the rewards screen shows: the held words, and the leaves of the claim store when it is given. */
export async function rewardRecords(
  db: NoteDb,
  leaves?: () => Promise<readonly RewardRecord[]>,
): Promise<RewardRecord[]> {
  return [...(await wordRecords(db)), ...(leaves ? await leaves() : [])]
}
