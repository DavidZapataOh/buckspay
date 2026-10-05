import { act } from 'react'
import { create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayError, type SettlementGateway } from '../lock/gateway'
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

  it('files the loss by itself when a settlement fails on a conflict, and says what happened', async () => {
    const claim = vi.fn(async () => ({ signature: '5claim' }))
    const settle = vi.fn(() => Promise.reject(new GatewayError(409, 'conflict', { recorded: 'ab12', selfPay: true })))
    const gateway = { settle, reclaim: vi.fn(), claim } as unknown as SettlementGateway
    await act(async () => {
      create(<Probe gateway={gateway} />)
    })
    await act(async () => {
      await last().settle(request)
    })
    expect(claim).toHaveBeenCalledWith(request)
    expect(last().state).toEqual({
      step: 'done',
      outcome: { kind: 'refused', refusal: { kind: 'conflict', recorded: 'ab12' }, selfPay: true },
      claim: { kind: 'burned', signature: '5claim' },
    })
  })

  it('files nothing for a settlement that fails for any other reason', async () => {
    const claim = vi.fn()
    const settle = vi.fn(() => Promise.reject(new GatewayError(409, 'window', { selfPay: true })))
    const gateway = { settle, reclaim: vi.fn(), claim } as unknown as SettlementGateway
    await act(async () => {
      create(<Probe gateway={gateway} />)
    })
    await act(async () => {
      await last().settle(request)
    })
    expect(claim).not.toHaveBeenCalled()
    expect(last().state).toMatchObject({ step: 'done' })
    expect(last().state).not.toHaveProperty('claim')
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
