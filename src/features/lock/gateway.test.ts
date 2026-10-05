import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGateway, GATEWAY_TIMEOUT_MS, GatewayError, notSent } from './gateway'

const gateway = createGateway('https://gateway.test')
const prepared = {
  transaction: 'AA==',
  feePayer: '2t2uAzmxvzM5caJZUeUd4Qg4Qcu39x978yoUzyher8fQ',
  blockhash: '5TeWSsjg2gbxCyWVniXeCmwM7UtHTCK7svzJr5xYJzHf',
  computeUnitLimit: 60_000,
  computeUnitPrice: 0,
  sponsorFee: '0',
}

function stub(answer: unknown = prepared, init?: ResponseInit) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(answer, init))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('gateway client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('gives up on a gateway that does not answer', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      (_: string, { signal }: RequestInit) =>
        new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason))),
    )
    const answer = expect(gateway.quote()).rejects.toThrow('aborted')
    await vi.advanceTimersByTimeAsync(GATEWAY_TIMEOUT_MS)
    await answer
  })

  it('reports a refusal with its status, and an answer that is not JSON with the status text', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: 'too many requests' }, { status: 429 }))
    await expect(gateway.quote()).rejects.toMatchObject({ status: 429, message: 'too many requests' })
    vi.stubGlobal('fetch', async () => new Response('<html></html>', { status: 502, statusText: 'Bad Gateway' }))
    const proxied = await gateway.submit('onboard', { key: '', transaction: '' }).catch((error: unknown) => error)
    expect(proxied).toMatchObject({ status: 502, message: 'Bad Gateway' })
    // A proxy's 502 does not say whether the gateway sent the transaction; the gateway's own refusals do.
    expect(notSent(proxied)).toBe(false)
    expect(notSent(new GatewayError(409, 'x'))).toBe(true)
  })

  it('asks for the quote and reads its amounts as integers', async () => {
    const fetch = stub({
      available: true,
      fee: '150000',
      feeMode: 'cost_plus',
      minFunding: '5000000',
      pressure: 50,
      maxLockDays: 45,
      reason: null,
    })
    expect(await gateway.quote()).toEqual({
      available: true,
      fee: 150_000n,
      feeMode: 'cost_plus',
      minFunding: 5_000_000n,
      pressure: 50,
      maxLockDays: 45,
      reason: null,
    })
    expect(fetch).toHaveBeenCalledWith(
      'https://gateway.test/v1/onboarding/quote',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it.each([
    ['onboard', '/v1/onboard', '/v1/onboard/submit'],
    ['lock', '/v1/locks', '/v1/locks/submit'],
    ['withdrawal', '/v1/withdrawals', '/v1/withdrawals/submit'],
    ['rotation-request', '/v1/rotations/request', '/v1/rotations/submit'],
    ['rotation-cancel', '/v1/rotations/cancel', '/v1/rotations/submit'],
  ] as const)('prepares and submits %s on its own routes', async (kind, prepare, submit) => {
    const fetch = stub()
    expect(await gateway.prepare(kind, { wallet: 'w' })).toEqual({ ...prepared, sponsorFee: 0n })
    expect(fetch).toHaveBeenLastCalledWith(
      `https://gateway.test${prepare}`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ wallet: 'w' }) }),
    )
    stub({ signature: 'sig' })
    expect(await gateway.submit(kind, { key: 'k', transaction: 't' })).toEqual({ signature: 'sig' })
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('registrations'), expect.anything())
    const sent = vi.mocked(globalThis.fetch).mock.calls[0]
    expect(sent[0]).toBe(`https://gateway.test${submit}`)
  })

  it('asks whether a wallet rotation is pending for a key', async () => {
    const fetch = stub({ pending: true, wallet: 'w', effectiveAt: 5 })
    expect(await gateway.rotationPending('02ab')).toEqual({ pending: true, wallet: 'w', effectiveAt: 5 })
    expect(fetch).toHaveBeenCalledWith('https://gateway.test/v1/rotations/pending?key=02ab', expect.anything())
  })
})
