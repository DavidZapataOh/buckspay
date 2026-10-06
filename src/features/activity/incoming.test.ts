import { describe, expect, it } from 'vitest'
import { party } from '../../payment/testing/world'
import { bundledTx, fakeRpc, M, OTHER_PROGRAM, OTHER_WALLET, settleTx, transferTx, W } from '../remote/testing'
import { fetchIncoming } from './incoming'

describe('incoming payments', () => {
  it('lists settlements that credited the wallet, by the settle_note’s own transfer', async () => {
    const rpc = fakeRpc([settleTx({ credit: 2_000_000n, payer: party(3) }), transferTx({ credit: 5n })])
    expect(await fetchIncoming(rpc, W, M)).toEqual([
      expect.objectContaining({ amount: 2_000_000n, from: party(3).key }),
    ])
  })
  it('ignores an SPL transfer bundled next to a settle_note of someone else', async () => {
    const rpc = fakeRpc([bundledTx({ settle: { credit: 5n, payee: OTHER_WALLET }, transfer: { credit: 7_000_000n } })])
    expect(await fetchIncoming(rpc, W, M)).toEqual([])
    const both = fakeRpc([bundledTx({ settle: { credit: 1_000n }, transfer: { credit: 7_000_000n } })])
    expect(await fetchIncoming(both, W, M)).toEqual([expect.objectContaining({ amount: 1_000n })])
  })
  it('ignores a failed transaction and asks only for finalized data', async () => {
    const rpc = fakeRpc([settleTx({ credit: 2_000_000n, err: { InstructionError: [0, 'Custom'] } })])
    expect(await fetchIncoming(rpc, W, M)).toEqual([])
    expect(rpc.commitments().every((c) => c === 'finalized')).toBe(true)
    expect(rpc.commitments().length).toBeGreaterThan(0)
  })
  it('drops an entry that is not finalized', async () => {
    const rpc = fakeRpc([settleTx({ credit: 2_000_000n, confirmationStatus: 'confirmed' })])
    expect(await fetchIncoming(rpc, W, M)).toEqual([])
  })
  it('ignores a settle_note that did not credit this wallet and transactions of other programs', async () => {
    const rpc = fakeRpc([settleTx({ credit: 0n }), settleTx({ credit: 1n, program: OTHER_PROGRAM, sig: 'other' })])
    expect(await fetchIncoming(rpc, W, M)).toEqual([])
  })
  it('resumes from the last seen signature', async () => {
    const rpc = fakeRpc([settleTx({ credit: 1n, sig: 'b' }), settleTx({ credit: 1n, sig: 'a' })])
    expect(await fetchIncoming(rpc, W, M, 'a')).toHaveLength(1)
    expect(rpc.lastBefore()).toBeUndefined()
    expect(rpc.lastUntil()).toBe('a')
  })
})
