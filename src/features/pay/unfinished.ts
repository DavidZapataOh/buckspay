import { safetyCode } from '../../payment/messages'
import type { Unfinished } from '../notes/outgoing'

/** What the Pay tab shows of a payment that was started and not finished. */
export type UnfinishedView = { messageId: Uint8Array; amount: bigint; code: string; signed: boolean }

/** The amount and the other phone of the payment as stored when it was prepared; a re-spend has no issue to read them from. */
export function unfinishedView(row: Unfinished): UnfinishedView {
  return {
    messageId: row.messageId,
    amount: row.amount,
    code: safetyCode(
      row.receiver.length === 32 ? { type: 'account', address: row.receiver } : { type: 'device', key: row.receiver },
    ),
    signed: row.state === 'signed',
  }
}
