export type WordRecord = {
  kind: 'word'
  state: 'held' | 'submitted' | 'in_tree' | 'rejected'
  /** What the word pays when it is settled. */
  value: bigint
  reason?: 'not_delivered' | 'not_added'
}

export type LeafRecord = {
  kind: 'leaf'
  state: 'unclaimed' | 'claiming' | 'claimed'
  /** The leaf pays `unit * 2^exp`. */
  exp: number
  unit: bigint
  signature?: string
}

export type RewardRecord = WordRecord | LeafRecord

export type RewardState = 'waiting' | 'ready' | 'claiming' | 'claimed' | 'not_paid'

export type RewardRow = {
  state: RewardState
  amount: bigint
  reason?: WordRecord['reason']
  signature?: string
}

const LEAF_STATE = { unclaimed: 'ready', claiming: 'claiming', claimed: 'claimed' } as const

/**
 * The screen state of every record. A word whose leaf is in the tree is shown through that leaf, so money is never
 * listed as claimable before the tree holds it.
 */
export function rewardRows(records: readonly RewardRecord[]): RewardRow[] {
  const rows: RewardRow[] = []
  for (const record of records) {
    if (record.kind === 'leaf') {
      rows.push({
        state: LEAF_STATE[record.state],
        amount: record.unit << BigInt(record.exp),
        signature: record.signature,
      })
    } else if (record.state === 'rejected') {
      rows.push({ state: 'not_paid', amount: record.value, reason: record.reason })
    } else if (record.state !== 'in_tree') {
      rows.push({ state: 'waiting', amount: record.value })
    }
  }
  return rows
}

/** What is owed, by state; a rejected word is owed nothing. */
export function totals(rows: readonly RewardRow[]): Record<Exclude<RewardState, 'not_paid'>, bigint> {
  const sum = { waiting: 0n, ready: 0n, claiming: 0n, claimed: 0n }
  for (const row of rows) if (row.state !== 'not_paid') sum[row.state] += row.amount
  return sum
}
