import type { Address } from '@solana/kit'
import { describe, expect, it, vi } from 'vitest'
import type { Bundle } from '../../payment/messages'
import { Reason } from '../../payment/reasons'
import type { ReceiveGate } from '../../payment/receive'
import { feeGate, recordFeeSource } from './fee-gate'

vi.mock('@react-native-async-storage/async-storage', () => import('../../test-support/async-storage'))

type Received = Parameters<ReceiveGate['admit']>[0]
const received = (amount: bigint) => ({ mint: new Uint8Array(32).fill(1), output: { amount } }) as unknown as Received
const bundle = (spends: number) => ({ spends: new Array(spends).fill(null) }) as unknown as Bundle

describe('feeGate', () => {
  it('admits a note that still pays what was asked after the fees of its chain', async () => {
    const gate = feeGate({ fee: async () => 5_000n, expected: 980_000n })
    expect(await gate.admit(received(1_000_000n), bundle(3))).toBeNull()
  })

  it('refuses a note padded with hops until the fees take more than the receiver can spare', async () => {
    const gate = feeGate({ fee: async () => 5_000n, expected: 980_000n })
    expect(await gate.admit(received(1_000_000n), bundle(4))).toBe(Reason.BelowNet)
  })

  it('does not look at a note nobody else held: it settles in the clear and pays no record fee', async () => {
    const fee = vi.fn(async () => 5_000_000n)
    expect(await feeGate({ fee, expected: 1_000_000n }).admit(received(1_000_000n), bundle(0))).toBeNull()
    expect(fee).not.toHaveBeenCalled()
  })

  it('admits when no fee is known, so a phone that was never online can still receive', async () => {
    expect(
      await feeGate({ fee: async () => undefined, expected: 1_000_000n }).admit(received(1_000_000n), bundle(5)),
    ).toBeNull()
  })
})

describe('recordFeeSource with no network', () => {
  const program = '11111111111111111111111111111111' as Address

  it('gives up when the network does not answer, so a receipt is never held back by it', async () => {
    const rpc = {
      getAccountInfo: () => ({
        send: ({ abortSignal }: { abortSignal: AbortSignal }) =>
          new Promise((_, reject) => abortSignal.addEventListener('abort', () => reject(new Error('aborted')))),
      }),
    }
    const answer = recordFeeSource(rpc as never, program, 20)(new Uint8Array(32).fill(1))
    expect(await answer).toBeUndefined()
  })
})
