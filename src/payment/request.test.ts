import { describe, expect, it } from 'vitest'
import { encodeRequest, PaymentError, requestIdOf } from './messages'
import { buildRequest, type RequestInput } from './request'
import { MINT, party } from './testing/world'

const shop = party(2)
const input = (over: Partial<RequestInput> = {}): RequestInput => ({
  amount: 5_000_000n,
  memo: 'Coffee',
  owner: { type: 'device', key: shop.key },
  mint: MINT,
  attesters: [7],
  now: 1_800_000_000,
  limits: { maxPayment: 100_000_000n, minWindow: 3600 },
  ...over,
})

describe('buildRequest', () => {
  it('builds the request from the amount, the owner, the mint and the attesters', () => {
    expect(buildRequest(input())).toEqual({
      owner: { type: 'device', key: shop.key },
      mint: MINT,
      amount: 5_000_000n,
      now: 1_800_000_000,
      minWindow: 3600,
      minHops: 1,
      attesters: [7],
      memo: 'Coffee',
    })
  })

  it('asks for one hop and the minimum window of the limits', () => {
    const request = buildRequest(input({ limits: { maxPayment: 100_000_000n, minWindow: 900 } }))
    expect([request.minHops, request.minWindow]).toEqual([1, 900])
  })

  it('asks for a note that can be passed on twice more only when told to', () => {
    expect(buildRequest(input()).minHops).toBe(1)
    expect(buildRequest(input({ minHops: 2 })).minHops).toBe(2)
  })

  it('accepts exactly the maximum and refuses zero, one unit above it and no attester', () => {
    expect(buildRequest(input({ amount: 100_000_000n })).amount).toBe(100_000_000n)
    for (const bad of [input({ amount: 0n }), input({ amount: 100_000_001n }), input({ attesters: [] })]) {
      expect(() => buildRequest(bad)).toThrow(PaymentError)
    }
  })

  it('cuts a memo at 48 bytes without splitting a character', () => {
    const request = buildRequest(input({ memo: 'é'.repeat(25) }))
    expect(request.memo).toBe('é'.repeat(24))
    expect(new TextEncoder().encode(request.memo)).toHaveLength(48)
    expect(buildRequest(input({ memo: 'ab' + '日'.repeat(20) })).memo).toBe('ab' + '日'.repeat(15))
  })

  it('gives the same bytes and the same request id for the same input', () => {
    expect(encodeRequest(buildRequest(input()))).toEqual(encodeRequest(buildRequest(input())))
    expect(requestIdOf(buildRequest(input()))).toEqual(requestIdOf(buildRequest(input())))
    expect(requestIdOf(buildRequest(input()))).not.toEqual(requestIdOf(buildRequest(input({ now: 1_800_000_001 }))))
  })
})
