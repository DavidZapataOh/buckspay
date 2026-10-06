import type { PaymentRequest } from '../../payment/messages'
import type { Reason } from '../../payment/reasons'
import type { Outcome } from '../../payment/receive'

type Accepted = Extract<Outcome, { accepted: true }>

export type ReceiveState =
  | { name: 'composing' }
  | { name: 'requesting'; request: PaymentRequest; expiresAt: number }
  | { name: 'expired'; request: PaymentRequest }
  | { name: 'scanning'; request: PaymentRequest; expiresAt: number }
  | { name: 'verifying'; request: PaymentRequest; expiresAt: number }
  | { name: 'accepted'; outcome: Accepted }
  | { name: 'rejected'; reason: Reason; request: PaymentRequest; expiresAt: number }

export type ReceiveEvent =
  | { type: 'create'; request: PaymentRequest; expiresAt: number }
  | { type: 'scan-payment' }
  | { type: 'cancel' }
  | { type: 'expire' }
  | { type: 'payment' }
  | { type: 'outcome'; outcome: Outcome }
  | { type: 'back' }
  | { type: 'finish' }

export const initialReceiveState: ReceiveState = { name: 'composing' }

/** The receiver's screens as a table of the only moves there are; any other event leaves the state as it is. */
export function receiveReducer(state: ReceiveState, event: ReceiveEvent): ReceiveState {
  switch (state.name) {
    case 'composing':
      return event.type === 'create'
        ? { name: 'requesting', request: event.request, expiresAt: event.expiresAt }
        : state
    case 'requesting':
      if (event.type === 'scan-payment') return { name: 'scanning', request: state.request, expiresAt: state.expiresAt }
      if (event.type === 'cancel') return initialReceiveState
      if (event.type === 'expire') return { name: 'expired', request: state.request }
      return state
    case 'expired':
      return event.type === 'finish' ? initialReceiveState : state
    case 'scanning':
      if (event.type === 'payment') return { name: 'verifying', request: state.request, expiresAt: state.expiresAt }
      if (event.type === 'back') return { name: 'requesting', request: state.request, expiresAt: state.expiresAt }
      return state
    case 'verifying':
      if (event.type !== 'outcome') return state
      return event.outcome.accepted
        ? { name: 'accepted', outcome: event.outcome }
        : { name: 'rejected', reason: event.outcome.reason, request: state.request, expiresAt: state.expiresAt }
    case 'accepted':
      return event.type === 'finish' ? initialReceiveState : state
    case 'rejected':
      if (event.type === 'scan-payment') return { name: 'scanning', request: state.request, expiresAt: state.expiresAt }
      if (event.type === 'finish') return initialReceiveState
      return state
  }
}
