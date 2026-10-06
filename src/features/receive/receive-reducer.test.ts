import { describe, expect, it } from 'vitest'
import type { PaymentRequest } from '../../payment/messages'
import { Reason } from '../../payment/reasons'
import type { Outcome } from '../../payment/receive'
import { type ReceiveEvent, receiveReducer, type ReceiveState } from './receive-reducer'

const request = { amount: 5n } as PaymentRequest
const accepted = { accepted: true, duplicate: false, messageId: new Uint8Array(32) } as Extract<
  Outcome,
  { accepted: true }
>
const refused: Outcome = { accepted: false, reason: Reason.Window, messageId: null }
const expiresAt = 1_000

const states: Record<ReceiveState['name'], ReceiveState> = {
  composing: { name: 'composing' },
  requesting: { name: 'requesting', request, expiresAt },
  expired: { name: 'expired', request },
  scanning: { name: 'scanning', request, expiresAt },
  verifying: { name: 'verifying', request, expiresAt },
  accepted: { name: 'accepted', outcome: accepted },
  rejected: { name: 'rejected', reason: Reason.Window, request, expiresAt },
}

const events: Record<string, ReceiveEvent> = {
  create: { type: 'create', request, expiresAt },
  scanPayment: { type: 'scan-payment' },
  cancel: { type: 'cancel' },
  expire: { type: 'expire' },
  payment: { type: 'payment' },
  accepted: { type: 'outcome', outcome: accepted },
  refused: { type: 'outcome', outcome: refused },
  back: { type: 'back' },
  finish: { type: 'finish' },
}

const table: [ReceiveState['name'], string, Partial<ReceiveState>][] = [
  ['composing', 'create', { name: 'requesting' }],
  ['requesting', 'scanPayment', { name: 'scanning' }],
  ['requesting', 'cancel', { name: 'composing' }],
  ['requesting', 'expire', { name: 'expired' }],
  ['expired', 'finish', { name: 'composing' }],
  ['scanning', 'payment', { name: 'verifying' }],
  ['scanning', 'back', { name: 'requesting' }],
  ['verifying', 'accepted', { name: 'accepted' }],
  ['verifying', 'refused', { name: 'rejected' }],
  ['accepted', 'finish', { name: 'composing' }],
  ['rejected', 'scanPayment', { name: 'scanning' }],
  ['rejected', 'finish', { name: 'composing' }],
]

describe('receiveReducer', () => {
  it('follows the table of 4.3', () => {
    for (const [from, event, after] of table) {
      expect(receiveReducer(states[from], events[event]), `${from} on ${event}`).toMatchObject(after)
    }
  })

  it('ignores every event the table does not list', () => {
    const listed = new Set(table.map(([from, event]) => `${from}:${event}`))
    for (const [name, state] of Object.entries(states)) {
      for (const [event, value] of Object.entries(events)) {
        if (listed.has(`${name}:${event}`)) continue
        expect(receiveReducer(state, value), `${name} on ${event}`).toBe(state)
      }
    }
  })

  it('never shows the request again after an accepted payment', () => {
    for (const [event, value] of Object.entries(events)) {
      const next = receiveReducer(states.accepted, value)
      if (event === 'finish') expect(next).toMatchObject({ name: 'composing' })
      else expect(next).toBe(states.accepted)
    }
    expect(states.accepted).not.toHaveProperty('request')
  })
})
