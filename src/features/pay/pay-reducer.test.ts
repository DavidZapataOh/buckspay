import { describe, expect, it } from 'vitest'
import type { PaymentRequest } from '../../payment/messages'
import type { Plan } from '../../payment/preflight'
import { PayError } from '../../payment/pay'
import { Reason } from '../../payment/reasons'
import { type PayEvent, payReducer, type PayState } from './pay-reducer'

const request = { amount: 5n } as PaymentRequest
const plan = { review: { amount: 5n } } as Plan
const payment = { messageId: new Uint8Array(32), bundle: new Uint8Array(4) }
const failure = new PayError('SignFailed')

const states: Record<PayState['name'], PayState> = {
  idle: { name: 'idle' },
  scanning: { name: 'scanning', wrongCode: false },
  reviewing: { name: 'reviewing', request, plan },
  refused: { name: 'refused', reason: 'NoLock', request },
  confirming: { name: 'confirming', request, plan },
  presenting: { name: 'presenting', payment },
  'awaiting-receipt': { name: 'awaiting-receipt', payment },
  confirmed: { name: 'confirmed', payment },
  rejected: { name: 'rejected', payment, reason: Reason.AboveMax },
  failed: { name: 'failed', error: failure, payment: undefined },
}

const events: Record<string, PayEvent> = {
  scan: { type: 'scan' },
  planned: { type: 'planned', request, planned: { ok: true, plan } },
  'planned-refused': { type: 'planned', request, planned: { ok: false, reason: 'AlreadyPaid' } },
  wrongCode: { type: 'wrong-code' },
  unreadable: { type: 'unreadable', step: 'E_PLAN' },
  confirm: { type: 'confirm' },
  sent: { type: 'sent', payment },
  failed: { type: 'failed', error: failure },
  resumed: { type: 'resumed', payment },
  scanReceipt: { type: 'scan-receipt' },
  confirmedReceipt: { type: 'receipt', result: { status: 'confirmed' } },
  rejectedReceipt: { type: 'receipt', result: { status: 'rejected', reason: Reason.OverLimit } },
  otherReceipt: { type: 'receipt', result: { status: 'other-payment' } },
  cancel: { type: 'cancel' },
  showAgain: { type: 'show-again' },
  back: { type: 'back' },
  finish: { type: 'finish' },
}

/** [state, event, state after]: every row of the table of the payer's hook. */
const table: [PayState['name'], string, Partial<PayState>][] = [
  ['idle', 'scan', { name: 'scanning' }],
  ['scanning', 'planned', { name: 'reviewing' }],
  ['scanning', 'planned-refused', { name: 'refused', reason: 'AlreadyPaid' }],
  ['scanning', 'wrongCode', { name: 'scanning', wrongCode: true }],
  ['scanning', 'unreadable', { name: 'scanning', unreadable: 'E_PLAN' }],
  ['scanning', 'back', { name: 'idle' }],
  ['reviewing', 'confirm', { name: 'confirming' }],
  ['reviewing', 'back', { name: 'idle' }],
  ['refused', 'back', { name: 'idle' }],
  ['confirming', 'sent', { name: 'presenting' }],
  ['confirming', 'failed', { name: 'failed', error: failure }],
  ['presenting', 'scanReceipt', { name: 'awaiting-receipt' }],
  ['presenting', 'finish', { name: 'idle' }],
  ['awaiting-receipt', 'confirmedReceipt', { name: 'confirmed' }],
  ['awaiting-receipt', 'rejectedReceipt', { name: 'rejected', reason: Reason.OverLimit }],
  ['awaiting-receipt', 'otherReceipt', { name: 'presenting' }],
  ['presenting', 'failed', { name: 'failed' }],
  ['awaiting-receipt', 'resumed', { name: 'presenting' }],
  ['awaiting-receipt', 'cancel', { name: 'presenting' }],
  ['confirmed', 'finish', { name: 'idle' }],
  ['rejected', 'showAgain', { name: 'presenting' }],
  ['rejected', 'finish', { name: 'idle' }],
  ['failed', 'resumed', { name: 'presenting' }],
  ['failed', 'finish', { name: 'idle' }],
  ['idle', 'resumed', { name: 'presenting' }],
  ['idle', 'failed', { name: 'failed', error: failure }],
  ['failed', 'failed', { name: 'failed', error: failure }],
]

describe('payReducer', () => {
  it('follows the table of 3.5', () => {
    for (const [from, event, after] of table) {
      expect(payReducer(states[from], events[event]), `${from} on ${event}`).toMatchObject(after)
    }
  })

  it('ignores every event the table does not list', () => {
    const listed = new Set(table.map(([from, event]) => `${from}:${event}`))
    for (const [name, state] of Object.entries(states)) {
      for (const [event, value] of Object.entries(events)) {
        if (listed.has(`${name}:${event}`)) continue
        expect(payReducer(state, value), `${name} on ${event}`).toBe(state)
      }
    }
  })

  it('keeps a request that was taken: a scan in any state but idle changes nothing', () => {
    expect(payReducer(states.presenting, events.scan)).toBe(states.presenting)
    expect(payReducer(states.confirming, events.confirm)).toBe(states.confirming)
  })
})
