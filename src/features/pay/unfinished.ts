import { safetyCode } from '../../payment/messages'
import { storedIssue } from '../../payment/pay'
import type { Unfinished } from '../notes/outgoing'

/** What the Pay tab shows of a payment that was started and not finished. */
export type UnfinishedView = { messageId: Uint8Array; amount: bigint; code: string; signed: boolean }

/** Reads the amount and the other phone from the stored issue: the same bytes that were or will be signed. */
export function unfinishedView(row: Unfinished): UnfinishedView {
  const issue = storedIssue(row.issueBody)
  return {
    messageId: row.messageId,
    amount: issue.amount,
    code: safetyCode(issue.owner),
    signed: row.state === 'signed',
  }
}
