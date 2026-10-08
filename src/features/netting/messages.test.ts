import { describe, expect, it } from 'vitest'
import { MessageKind } from '../../transport/types'
import { AbortReason, decodeMessage, encodeMessage, MessageError, type SessionMessage, SessionType } from './messages'
import { sample } from './testing/samples'

const messages: SessionMessage[] = sample.all()

describe('session messages', () => {
  it.each(messages.map((m) => [m.type, m] as const))('%s round-trips byte for byte', (_name, message) => {
    const { type, body } = encodeMessage(message)
    expect(type).toBe(SessionType[message.type])
    const again = decodeMessage(type, body, sample.participants)
    expect(again).toEqual(message)
    expect(encodeMessage(again).body).toEqual(body)
  })

  it.each(messages.map((m) => [m.type, m] as const))('%s refuses every truncation and a trailing byte', (_name, message) => {
    const { type, body } = encodeMessage(message)
    // A relayed transport message is opaque and has no length of its own: only its three-byte header can be cut.
    const shortest = message.type === 'Relay' ? 3 : body.length
    for (let length = 0; length < shortest; length++) {
      expect(() => decodeMessage(type, body.slice(0, length), sample.participants)).toThrow(MessageError)
    }
    if (message.type !== 'Relay') {
      expect(() => decodeMessage(type, Uint8Array.of(...body, 0), sample.participants)).toThrow(MessageError)
    }
  })

  it('refuses_counts_and_participants_out_of_range', () => {
    const roster = encodeMessage(sample.roster(8)).body
    expect(() => decodeMessage(SessionType.Roster, Uint8Array.of(9, ...roster.slice(1)), 8)).toThrow(MessageError)
    expect(() => decodeMessage(SessionType.Roster, Uint8Array.of(2, ...roster.slice(1, 165)), 8)).toThrow(MessageError)
    expect(() => decodeMessage(SessionType.Roster, Uint8Array.of(0), 8)).toThrow(MessageError)
    const tabs = encodeMessage(sample.tabs(7)).body
    expect(() => decodeMessage(SessionType.Tabs, Uint8Array.of(8, ...tabs.slice(1)), 8)).toThrow(MessageError)
    const proposal = encodeMessage(sample.proposal(5)).body
    expect(() => decodeMessage(SessionType.Proposal, Uint8Array.from(proposal, (b, i) => (i === 66 ? 9 : b)), 5)).toThrow(MessageError)
    expect(() => decodeMessage(SessionType.Proposal, Uint8Array.from(proposal, (b, i) => (i === 66 ? 1 : b)), 5)).toThrow(MessageError)
  })

  it('proposal_is_self_delimiting_and_final_needs_the_participant_count', () => {
    for (const n of [2, 5, 8]) {
      const { body } = encodeMessage(sample.proposal(n))
      expect(decodeMessage(SessionType.Proposal, body)).toEqual(sample.proposal(n))
    }
    const { body } = encodeMessage(sample.final(5))
    expect(body).toHaveLength(64 * 5 + 256)
    expect(() => decodeMessage(SessionType.Final, body)).toThrow(MessageError)
    expect(() => decodeMessage(SessionType.Final, body, 4)).toThrow(MessageError)
  })

  it('relay_carries_a_whole_transport_message_and_refuses_unknown_kinds', () => {
    const relay: SessionMessage = { type: 'Relay', from: 2, to: 5, kind: MessageKind.Payment, payload: new Uint8Array(1500).fill(7) }
    const { type, body } = encodeMessage(relay)
    expect(body.slice(0, 3)).toEqual(Uint8Array.of(2, 5, MessageKind.Payment))
    expect(decodeMessage(type, body)).toEqual(relay)
    expect(() => decodeMessage(type, Uint8Array.of(2, 5, 7, 1))).toThrow(MessageError)
    expect(() => decodeMessage(type, Uint8Array.of(2, 8, MessageKind.Payment))).toThrow(MessageError)
  })

  it('unknown_type_and_abort_reason_refused', () => {
    expect(() => decodeMessage(0x1c, new Uint8Array(1))).toThrow(MessageError)
    expect(() => decodeMessage(0x0f, new Uint8Array(1))).toThrow(MessageError)
    expect(() => decodeMessage(SessionType.Abort, Uint8Array.of(0))).toThrow(MessageError)
    expect(decodeMessage(SessionType.Abort, Uint8Array.of(AbortReason.Refused))).toEqual({ type: 'Abort', reason: 4 })
  })

  it('simplify_carries_a_variable_length_via_and_approve_lists_indexes', () => {
    const simplify: SessionMessage = { type: 'Simplify', transfers: [{ payer: 0, payee: 3, amount: 5_000_000n, via: [1, 2] }, { payer: 4, payee: 2, amount: 1n, via: [] }] }
    const { type, body } = encodeMessage(simplify)
    expect(type).toBe(SessionType.Simplify)
    expect(body).toHaveLength(1 + (11 + 2) + (11 + 0))
    expect(decodeMessage(type, body)).toEqual(simplify)
    expect(() => decodeMessage(type, Uint8Array.from(body, (b, i) => (i === 11 ? 7 : b)))).toThrow(MessageError)
    const approve: SessionMessage = { type: 'SimplifyApprove', approved: [0, 2] }
    expect(encodeMessage(approve)).toEqual({ type: SessionType.SimplifyApprove, body: Uint8Array.of(2, 0, 2) })
    expect(decodeMessage(SessionType.SimplifyApprove, Uint8Array.of(0))).toEqual({ type: 'SimplifyApprove', approved: [] })
    expect(() => decodeMessage(SessionType.SimplifyApprove, Uint8Array.of(2, 0))).toThrow(MessageError)
  })

  it('retired_types_0x18_and_0x19_are_refused', () => {
    for (const type of [0x18, 0x19]) for (const body of [new Uint8Array(0), Uint8Array.of(1), new Uint8Array(277)])
      expect(() => decodeMessage(type, body)).toThrow(MessageError)
  })

  it('every_message_fits_one_transport_message_with_the_frame_overhead', () => {
    for (const message of [sample.roster(8), sample.tabs(7), sample.proposal(8), sample.final(8)]) {
      expect(encodeMessage(message).body.length + 1 + 26).toBeLessThanOrEqual(8192)
    }
  })
})
