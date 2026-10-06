import { buildRequest } from '../../payment/request'
import type { PaymentRequest } from '../../payment/messages'
import { PAY_LIMITS } from '../pay/limits'
import type { PayLink } from './pay-link'

/** How long a remote note must stay settleable, seconds: long enough for a phone with internet to pass by. */
export const REMOTE_MIN_WINDOW = 48 * 3600

/** The request a remote payment is planned and signed from: it pays the friend's account, never a device. */
export function remoteRequest(
  contact: PayLink,
  amount: bigint,
  memo: string,
  ctx: { now: number; attesters: readonly number[] },
): PaymentRequest {
  return buildRequest({
    amount,
    memo,
    owner: { type: 'account', address: contact.wallet },
    mint: contact.mint,
    attesters: ctx.attesters,
    now: ctx.now,
    minHops: 1,
    limits: { maxPayment: PAY_LIMITS.maxPayment, minWindow: REMOTE_MIN_WINDOW },
  })
}
