import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { safetyCode } from '../../payment/messages'
import { formatMoney } from '../../utils/format-amount'
import { copy, text } from '../payment/copy'
import type { ActivityRow } from '../notes/activity'

/** The route parameter of a row: which table it is from, and its id. */
export const activityId = (row: Pick<ActivityRow, 'kind' | 'id'>) => `${row.kind}-${bytesToHex(row.id)}`

export function parseActivityId(id: string): { kind: ActivityRow['kind']; id: Uint8Array } | undefined {
  const match = /^(paid|received)-([0-9a-f]{64})$/.exec(id)
  return match ? { kind: match[1] as ActivityRow['kind'], id: hexToBytes(match[2]) } : undefined
}

/** The word for a row's state. */
export const statusWord = (row: Pick<ActivityRow, 'state' | 'handedTo'>) =>
  row.state === 'relay-handed'
    ? row.handedTo === 1
      ? copy.activity.relayHandedOne
      : text(copy.activity.relayHanded, { count: String(row.handedTo ?? 0) })
    : (copy.activity.status[row.state as keyof typeof copy.activity.status] ?? row.state)

/** "Paid 5.00 USDC · phone ABCD-EF23 · Confirmed" or "Received 5.00 USDC · Settled". */
export function sentence(row: ActivityRow, symbol: string, decimals: number): string {
  const values = { amount: formatMoney(row.amount, decimals), symbol, status: statusWord(row) }
  return row.kind === 'paid'
    ? text(copy.activity.paid, { ...values, code: safetyCode({ type: 'device', key: row.counterparty }) })
    : text(copy.activity.received, values)
}
