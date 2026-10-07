import { describe, expect, it, vi } from 'vitest'
import { sweepQuote } from './sweep-quote'

describe('sweep quote', () => {
  it('reads the amounts as base units', async () => {
    const request = vi.fn(async () =>
      Response.json({
        gateway: 'g',
        feeAccount: 'f',
        fee: '20000',
        feeWithAccount: '2100000',
        computeUnitLimit: 40000,
        computeUnitPrice: '10000',
      }),
    )
    expect(await sweepQuote('https://gw', request as unknown as typeof fetch)()).toMatchObject({
      fee: 20_000n,
      feeWithAccount: 2_100_000n,
      computeUnitPrice: 10_000n,
    })
    expect(request).toHaveBeenCalledWith('https://gw/v1/sweeps/quote')
  })

  it('says what the gateway answered when it refuses', async () => {
    const request = vi.fn(async () => new Response(null, { status: 404 }))
    await expect(sweepQuote('https://gw', request as unknown as typeof fetch)()).rejects.toThrow(
      'The gateway answered 404.',
    )
  })
})
