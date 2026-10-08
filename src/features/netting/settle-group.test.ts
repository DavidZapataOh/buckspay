import { describe, expect, it, vi } from 'vitest'
import { GatewayError } from '../lock/gateway'
import { settleGroup } from './settle-group'

const chain = (n: number) => ({ issue: `0${n}`, spends: [`1${n}`] })

describe('settle together', () => {
  it('posts the chains and returns the transactions and the refusals', async () => {
    const body = { transactions: [{ signature: 'S', indexes: [0, 2] }], refused: [{ index: 1, reason: 'spent' }] }
    const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    expect(await settleGroup([chain(0), chain(1), chain(2)], { url: 'https://g', fetch })).toEqual(body)
    const [path, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('https://g/v1/settlements/group')
    expect(JSON.parse(init.body as string)).toEqual({ settlements: [chain(0), chain(1), chain(2)] })
  })

  it('refuses more than eight chains or none before any request', async () => {
    const fetch = vi.fn()
    await expect(settleGroup([], { url: 'https://g', fetch })).rejects.toThrow(RangeError)
    await expect(
      settleGroup(
        Array.from({ length: 9 }, (_, i) => chain(i)),
        { url: 'https://g', fetch },
      ),
    ).rejects.toThrow(RangeError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('throws the gateway error of a refused request', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'bad_request' }), { status: 400 }))
    await expect(settleGroup([chain(0)], { url: 'https://g', fetch })).rejects.toBeInstanceOf(GatewayError)
  })
})
