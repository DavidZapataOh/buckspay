import { type Transport, MessageKind } from '../transport/types'
import { decodeRequest, PaymentError, type PaymentRequest } from './messages'

/**
 * Waits for a payment request on the medium. A message of another kind, or one that does not decode as a
 * request, is reported through `onWrongCode` and the wait goes on.
 */
export async function awaitRequest(
  transport: Transport,
  { signal, onWrongCode }: { signal?: AbortSignal; onWrongCode: () => void },
): Promise<PaymentRequest> {
  for (;;) {
    const message = await transport.receive({ signal })
    if (message.kind === MessageKind.Request) {
      try {
        return decodeRequest(message.payload)
      } catch (error) {
        if (!(error instanceof PaymentError)) throw error
      }
    }
    onWrongCode()
  }
}
