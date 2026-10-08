import type { PaymentRequest } from '../../payment/messages'
import type { PayError, ReceiptResult, SentPayment } from '../../payment/pay'
import type { Plan, Planned, PlanRefusal } from '../../payment/preflight'
import type { RespendPlan } from '../../payment/respend'
import type { Reason } from '../../payment/reasons'

/** The step of reading a request that failed, as a short code a person can report. */
export type ScanStep = 'E_READ' | 'E_STORE' | 'E_PLAN'

export type PayState =
  | { name: 'idle' }
  | { name: 'scanning'; wrongCode: boolean; unreadable?: ScanStep; timedOut?: true }
  | { name: 'reviewing'; request: PaymentRequest; plan: Plan | RespendPlan }
  | { name: 'refused'; reason: PlanRefusal; lockSeq?: number; request: PaymentRequest }
  | { name: 'confirming'; request: PaymentRequest; plan: Plan | RespendPlan }
  | { name: 'presenting'; payment: SentPayment; otherReceipt?: boolean; unconfirmed?: true }
  | { name: 'awaiting-receipt'; payment: SentPayment }
  | { name: 'confirmed'; payment: SentPayment }
  | { name: 'rejected'; payment: SentPayment; reason: Reason }
  | { name: 'failed'; error: PayError; payment?: SentPayment }

export type PayEvent =
  | { type: 'scan' }
  | { type: 'planned'; request: PaymentRequest; planned: Planned | { ok: true; plan: RespendPlan } }
  | { type: 'wrong-code' }
  | { type: 'unreadable'; step: ScanStep }
  | { type: 'timed-out' }
  | { type: 'confirm' }
  | { type: 'sent'; payment: SentPayment }
  | { type: 'resumed'; payment: SentPayment }
  | { type: 'failed'; error: PayError }
  | { type: 'scan-receipt' }
  | { type: 'receipt'; result: ReceiptResult }
  | { type: 'receipt-timed-out' }
  | { type: 'cancel' }
  | { type: 'show-again' }
  | { type: 'back' }
  | { type: 'finish' }

export const initialPayState: PayState = { name: 'idle' }

/** The payer's screens as a table of the only moves there are; any other event leaves the state as it is. */
export function payReducer(state: PayState, event: PayEvent): PayState {
  switch (state.name) {
    case 'idle':
      if (event.type === 'scan') return { name: 'scanning', wrongCode: false }
      if (event.type === 'resumed') return { name: 'presenting', payment: event.payment }
      if (event.type === 'failed') return { name: 'failed', error: event.error }
      return state
    case 'scanning':
      if (event.type === 'planned') {
        const { planned, request } = event
        return planned.ok
          ? { name: 'reviewing', request, plan: planned.plan }
          : { name: 'refused', reason: planned.reason, lockSeq: planned.lockSeq, request }
      }
      if (event.type === 'wrong-code') return state.wrongCode ? state : { name: 'scanning', wrongCode: true }
      if (event.type === 'unreadable') return { name: 'scanning', wrongCode: false, unreadable: event.step }
      if (event.type === 'timed-out') return { name: 'scanning', wrongCode: false, timedOut: true }
      if (event.type === 'back') return initialPayState
      return state
    case 'reviewing':
      if (event.type === 'confirm') return { name: 'confirming', request: state.request, plan: state.plan }
      if (event.type === 'back') return initialPayState
      return state
    case 'refused':
      return event.type === 'back' ? initialPayState : state
    case 'confirming':
      if (event.type === 'sent') return { name: 'presenting', payment: event.payment }
      if (event.type === 'failed') return { name: 'failed', error: event.error }
      return state
    case 'presenting':
      if (event.type === 'scan-receipt') return { name: 'awaiting-receipt', payment: state.payment }
      if (event.type === 'failed') return { name: 'failed', error: event.error, payment: state.payment }
      if (event.type === 'finish') return initialPayState
      return state
    case 'awaiting-receipt':
      if (event.type === 'resumed') return { name: 'presenting', payment: event.payment }
      if (event.type === 'cancel') return { name: 'presenting', payment: state.payment }
      if (event.type === 'receipt-timed-out') return { name: 'presenting', payment: state.payment, unconfirmed: true }
      if (event.type !== 'receipt') return state
      if (event.result.status === 'confirmed') return { name: 'confirmed', payment: state.payment }
      if (event.result.status === 'rejected') {
        return { name: 'rejected', payment: state.payment, reason: event.result.reason }
      }
      return { name: 'presenting', payment: state.payment }
    case 'confirmed':
      return event.type === 'finish' ? initialPayState : state
    case 'rejected':
      if (event.type === 'show-again') return { name: 'presenting', payment: state.payment }
      if (event.type === 'finish') return initialPayState
      return state
    case 'failed':
      if (event.type === 'resumed') return { name: 'presenting', payment: event.payment }
      if (event.type === 'failed') return { name: 'failed', error: event.error }
      if (event.type === 'finish') return initialPayState
      return state
  }
}
