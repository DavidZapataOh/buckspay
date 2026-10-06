import type { PaymentRequest } from '../../payment/messages'
import type { TransportId } from '../../transport/types'
import type { Band } from './app-port'
import { type WitnessPolicy, type WitnessSettings, witnessPolicy } from './policy'

/** What the receiver writes in the request: whether it will ask for a check on this payment, and on which band. */
export function requestWitness(
  transport: TransportId,
  amount: bigint,
  settings: WitnessSettings,
): PaymentRequest['witness'] {
  if (witnessPolicy({ role: 'receiver', transport, amount, settings }) === 'off') return 'none'
  return settings.audible ? 'audible' : 'ultrasound'
}

/** How the payer takes part in the check the request announces; there is no band to use when none was asked. */
export function payerAnswer(
  transport: TransportId,
  request: Pick<PaymentRequest, 'witness' | 'amount'>,
  settings: WitnessSettings,
): { policy: WitnessPolicy; band: Band | null } {
  if (request.witness === 'none') return { policy: 'off', band: null }
  const policy = witnessPolicy({ role: 'payer', transport, amount: request.amount, settings, requested: true })
  return { policy, band: request.witness }
}
