import { describe, expect, it, vi } from 'vitest'
import { GRACE } from '../../protocol'
import { checkDelivery, MARGIN, nextState } from './delivery'
import { fakeChainRpc, outboxRow, PROGRAM_FOR_TESTS } from './testing'

const E = 1_800_000_000

describe('remote payment states', () => {
  it('moves forward on observed events only', () => {
    let s = nextState('signed', { type: 'stored', by: 'carrier', at: 1 })
    expect(s).toBe('received')
    s = nextState(s, { type: 'answer', answer: { status: 'submitted' }, at: 2 })
    expect(s).toBe('relaying')
    s = nextState(s, { type: 'answer', answer: { status: 'settled', signature: 's' }, at: 3 })
    expect(s).toBe('delivered')
  })
  it('a retry answer keeps the state, and a refused answer without a final reason is a retry', () => {
    expect(nextState('received', { type: 'answer', answer: { status: 'retry', retryAfter: 600 }, at: 2 })).toBe(
      'received',
    )
    expect(nextState('relaying', { type: 'answer', answer: { status: 'retry', retryAfter: 600 }, at: 2 })).toBe(
      'relaying',
    )
    expect(
      nextState('received', { type: 'answer', answer: { status: 'refused', reason: 'daily_cap' } as never, at: 2 }),
    ).toBe('received')
  })
  it('never moves back, and final states stay final', () => {
    expect(nextState('relaying', { type: 'stored', by: 'carrier', at: 9 })).toBe('relaying')
    expect(
      nextState('delivered', {
        type: 'chain',
        record: 'none',
        commitment: 'finalized',
        blockTime: E + GRACE + MARGIN + 1,
        expiry: E,
      }),
    ).toBe('delivered')
    expect(nextState('expired', { type: 'answer', answer: { status: 'settled', signature: 's' }, at: 9 })).toBe(
      'expired',
    )
  })
  it('a duplicate answer means another copy got there: not yet delivered until settled or read on chain', () => {
    expect(nextState('received', { type: 'answer', answer: { status: 'duplicate' }, at: 2 })).toBe('relaying')
    expect(
      nextState('relaying', { type: 'chain', record: 'ours', commitment: 'finalized', blockTime: 5, expiry: E }),
    ).toBe('delivered')
  })
  it('expires only on a finalized read whose block time is past expiry plus grace plus margin', () => {
    const none = { type: 'chain', record: 'none', expiry: E } as const
    expect(nextState('received', { ...none, commitment: 'finalized', blockTime: E + GRACE + MARGIN })).toBe('received')
    expect(nextState('received', { ...none, commitment: 'finalized', blockTime: E + GRACE + MARGIN + 1 })).toBe(
      'expired',
    )
    expect(nextState('received', { ...none, commitment: 'confirmed', blockTime: E + GRACE + MARGIN + 1 })).toBe(
      'received',
    )
  })
  it('a record with another content or a final refused answer is refused', () => {
    expect(
      nextState('relaying', { type: 'chain', record: 'other', commitment: 'finalized', blockTime: 5, expiry: E }),
    ).toBe('refused')
    expect(nextState('received', { type: 'answer', answer: { status: 'refused', reason: 'window' }, at: 2 })).toBe(
      'refused',
    )
  })
})

describe('checkDelivery', () => {
  it('a phone clock three hours ahead never expires a live note', async () => {
    vi.useFakeTimers()
    vi.setSystemTime((E + GRACE + 3 * 3_600) * 1000)
    const rpc = fakeChainRpc({ record: null, slotBlockTime: E + 60 })
    const ev = await checkDelivery(rpc, outboxRow({ expiry: E }), PROGRAM_FOR_TESTS)
    expect(rpc.commitments()).toEqual(['finalized'])
    expect(nextState('relaying', ev)).toBe('relaying')
    vi.useRealTimers()
  })
  it('a block time past the deadline on a finalized read expires it', async () => {
    const rpc = fakeChainRpc({ record: null, slotBlockTime: E + GRACE + MARGIN + 1 })
    expect(nextState('relaying', await checkDelivery(rpc, outboxRow({ expiry: E }), PROGRAM_FOR_TESTS))).toBe('expired')
  })
  it('a missing block time reads again and never reports no record', async () => {
    const rpc = fakeChainRpc({ record: null, slotBlockTimes: [null, E + GRACE + MARGIN + 1] })
    expect(nextState('relaying', await checkDelivery(rpc, outboxRow({ expiry: E }), PROGRAM_FOR_TESTS))).toBe('expired')
    const never = fakeChainRpc({ record: null, slotBlockTimes: [null] })
    expect(nextState('relaying', await checkDelivery(never, outboxRow({ expiry: E }), PROGRAM_FOR_TESTS))).toBe(
      'relaying',
    )
  })
  it('reads the record of the output: our content is delivered, another content is refused', async () => {
    const row = outboxRow({ expiry: E })
    const ours = fakeChainRpc({ record: { content: row.content!, flags: 1 }, slotBlockTime: 1 })
    expect(nextState('relaying', await checkDelivery(ours, row, PROGRAM_FOR_TESTS))).toBe('delivered')
    const other = fakeChainRpc({ record: { content: new Uint8Array(32).fill(9), flags: 1 }, slotBlockTime: 1 })
    expect(nextState('relaying', await checkDelivery(other, row, PROGRAM_FOR_TESTS))).toBe('refused')
  })
  it('does not trust an account at the record address that another program owns', async () => {
    const row = outboxRow({ expiry: E })
    const foreign = fakeChainRpc({
      record: { content: row.content!, flags: 1, owner: new Uint8Array(32).fill(9) },
      slotBlockTime: E + GRACE + MARGIN + 1,
    })
    expect(nextState('relaying', await checkDelivery(foreign, row, PROGRAM_FOR_TESTS))).toBe('expired')
  })
})
