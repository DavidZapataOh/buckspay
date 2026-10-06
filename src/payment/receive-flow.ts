import { mark, report } from '../features/pay/timing'
import { type Transport, MessageKind } from '../transport/types'
import { encodeReceipt, encodeRequest, type PaymentRequest } from './messages'
import { Reason } from './reasons'
import { acceptPayment, type Outcome, type ReceiveContext } from './receive'

/** Puts the request on the medium; it stays there until the next `send` or `close`. */
export const showRequest = (request: PaymentRequest, transport: Transport) =>
  transport.send({ kind: MessageKind.Request, payload: encodeRequest(request) })

/**
 * Waits for one payment, accepts or refuses it, and answers with an unsigned receipt. A receipt that
 * cannot be sent changes nothing: the note is stored and the outcome is returned all the same. The
 * context may be made once the payment has arrived, so its clock is the time of the check.
 */
export async function receivePayment(
  context: ReceiveContext | (() => Promise<ReceiveContext>),
  transport: Transport,
  { onWrongCode, ...options }: { signal?: AbortSignal; timeoutMs?: number; onWrongCode?: () => void } = {},
): Promise<Outcome> {
  let message = await transport.receive({ ...options, accept: onWrongCode ? undefined : [MessageKind.Payment] })
  while (message.kind !== MessageKind.Payment) {
    onWrongCode?.()
    message = await transport.receive(options)
  }
  const ctx = typeof context === 'function' ? await context() : context
  mark('scanned')
  const outcome = await acceptPayment(message.payload, ctx)
  const receipt = encodeReceipt({
    accepted: outcome.accepted,
    reason: outcome.accepted ? Reason.Accepted : outcome.reason,
    messageId: outcome.messageId ?? new Uint8Array(32),
  })
  try {
    await transport.send({ kind: MessageKind.Receipt, payload: receipt })
  } catch {
    // The receipt is a convenience for the payer.
  }
  mark('receipt-sent')
  report()
  return outcome
}
