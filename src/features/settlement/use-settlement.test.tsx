import { act } from 'react'
import { create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettlementGateway } from '../lock/gateway'
import { useSettlement } from './use-settlement'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const request = { issue: 'aa', spends: [] }
let seen: ReturnType<typeof useSettlement>[] = []
function Probe({ gateway }: { gateway?: SettlementGateway }) {
  seen.push(useSettlement(gateway))
  return null
}
const last = () => seen[seen.length - 1]

describe('settlement hook', () => {
  beforeEach(() => {
    seen = []
  })

  it('goes from idle through sending to the outcome of the gateway', async () => {
    const answer = Promise.withResolvers<{ signature: string }>()
    const settle = vi.fn(() => answer.promise)
    const gateway = {
      settle,
      reclaim: vi.fn(async () => ({ status: 'settled' as const })),
    } as unknown as SettlementGateway
    await act(async () => {
      create(<Probe gateway={gateway} />)
    })
    expect(last().state).toEqual({ step: 'idle' })
    let pending: Promise<unknown>
    await act(async () => {
      pending = last().settle(request)
    })
    expect(last().state).toEqual({ step: 'sending' })
    await act(async () => {
      answer.resolve({ signature: '5sig' })
      await pending
    })
    expect(last().state).toEqual({ step: 'done', outcome: { kind: 'sent', signature: '5sig' } })
    expect(settle).toHaveBeenCalledWith(request)
    await act(async () => {
      await last().reclaim({ ...request, owner: 'cc', which: 0, deadline: 1, signature: 'dd' })
    })
    expect(last().state).toEqual({ step: 'done', outcome: { kind: 'settled' } })
  })

  it('does nothing without a gateway, and says it does not know', async () => {
    await act(async () => {
      create(<Probe />)
    })
    let outcome: unknown
    await act(async () => {
      outcome = await last().settle(request)
    })
    expect(outcome).toEqual({ kind: 'unknown' })
    expect(last().state).toEqual({ step: 'idle' })
  })
})
