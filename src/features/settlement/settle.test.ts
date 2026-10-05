import { describe, expect, it } from 'vitest'
import { GatewayError, type SettlementGateway } from '../lock/gateway'
import { reclaim, settle } from './settle'

const request = { issue: 'aa', spends: ['bb'] }
const reclaimRequest = { ...request, owner: 'cc', which: 0 as const, deadline: 1, signature: 'dd' }
const gatewayThatAnswers = (answer: () => Promise<unknown>) =>
  ({ settle: answer, reclaim: answer }) as unknown as SettlementGateway
const refusing = (status: number, body: Record<string, unknown>) =>
  gatewayThatAnswers(() => Promise.reject(new GatewayError(status, String(body.error), body)))

describe('settling through the gateway', () => {
  it('says the transaction was sent, or that the record was paid already', async () => {
    expect(
      await settle(
        gatewayThatAnswers(async () => ({ signature: '5xyz' })),
        request,
      ),
    ).toEqual({
      kind: 'sent',
      signature: '5xyz',
    })
    expect(
      await settle(
        gatewayThatAnswers(async () => ({ status: 'settled' })),
        request,
      ),
    ).toEqual({ kind: 'settled' })
  })

  it('reads every refusal and whether the wallet can pay for the transaction itself', async () => {
    const refused = async (status: number, body: Record<string, unknown>) =>
      settle(refusing(status, { selfPay: true, ...body }), request)
    expect(await refused(409, { error: 'conflict', recorded: 'ab12' })).toEqual({
      kind: 'refused',
      refusal: { kind: 'conflict', recorded: 'ab12' },
      selfPay: true,
    })
    expect((await refused(409, { error: 'no_token_account' })).kind).toBe('refused')
    for (const kind of ['window', 'closed', 'deadline', 'lock_ended']) {
      expect(await refused(409, { error: kind })).toMatchObject({ refusal: { kind } })
    }
    expect(await refused(422, { error: 'horizon', retryAt: 1_900_000_000 })).toMatchObject({
      refusal: { kind: 'horizon', retryAt: 1_900_000_000 },
    })
    expect(await refused(422, { error: 'below_minimum', minimum: '50000' })).toMatchObject({
      refusal: { kind: 'below_minimum', minimum: 50_000n },
    })
    expect(await refused(429, { error: 'key_limit' })).toMatchObject({
      refusal: { kind: 'limited', reason: 'key_limit' },
    })
    expect(await refused(503, { error: 'float_cap', retryAfter: 90 })).toMatchObject({
      refusal: { kind: 'busy', reason: 'float_cap', retryAfter: 90 },
    })
    expect(await refused(409, { error: 'wrong_lock' })).toMatchObject({
      refusal: { kind: 'lock', reason: 'wrong_lock' },
    })
    expect(await settle(refusing(400, { error: 'the chain does not verify' }), request)).toEqual({
      kind: 'refused',
      refusal: { kind: 'invalid', message: 'the chain does not verify' },
      selfPay: false,
    })
  })

  it('keeps the chain when nothing says whether the gateway sent it', async () => {
    expect(await settle(refusing(502, { error: 'Bad Gateway' }), request)).toEqual({ kind: 'unknown' })
    expect(
      await settle(
        gatewayThatAnswers(() => Promise.reject(new TypeError('Network request failed'))),
        request,
      ),
    ).toEqual({
      kind: 'unknown',
    })
  })

  it('reclaims through its own route with the same outcomes', async () => {
    expect(
      await reclaim(
        gatewayThatAnswers(async () => ({ signature: '5abc' })),
        reclaimRequest,
      ),
    ).toEqual({
      kind: 'sent',
      signature: '5abc',
    })
    expect(await reclaim(refusing(409, { error: 'closed', selfPay: true }), reclaimRequest)).toMatchObject({
      refusal: { kind: 'closed' },
    })
  })
})
