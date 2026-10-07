import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGateway, GATEWAY_TIMEOUT_MS, GatewayError, notSent, REDELIVERY_WAITS_MS } from './gateway'

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

  const unknownHost = () =>
    new Error('fetch failed: java.net.UnknownHostException: Unable to resolve host "gateway.test"')

  it('sends a request again, after waiting, while it never left the phone', async () => {
    vi.useFakeTimers()
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(unknownHost())
      .mockRejectedValueOnce(unknownHost())
      .mockResolvedValue(Response.json({ signature: 'sig' }))
    vi.stubGlobal('fetch', fetch)
    const answer = gateway.submit('lock', { key: '00', transaction: 'AA==' })
    await vi.advanceTimersByTimeAsync(REDELIVERY_WAITS_MS[0] + REDELIVERY_WAITS_MS[1])
    expect(await answer).toEqual({ signature: 'sig' })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('gives up after its attempts, and never sends again after a timeout or an answer', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockRejectedValue(unknownHost())
    vi.stubGlobal('fetch', fetch)
    const answer = expect(gateway.quote()).rejects.toThrow('UnknownHostException')
    await vi.advanceTimersByTimeAsync(REDELIVERY_WAITS_MS.reduce((a, b) => a + b))
    await answer
    expect(fetch).toHaveBeenCalledTimes(REDELIVERY_WAITS_MS.length + 1)

    fetch.mockReset().mockRejectedValue(new Error('java.net.SocketTimeoutException: timeout'))
    await expect(gateway.quote()).rejects.toThrow('SocketTimeoutException')
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockReset().mockResolvedValue(Response.json({ error: 'busy' }, { status: 503 }))
    await expect(gateway.quote()).rejects.toMatchObject({ status: 503 })
    expect(fetch).toHaveBeenCalledTimes(1)
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

  it('asks for the settlement quote and reads its amount as an integer', async () => {
    const fetch = stub({ minAmount: '50000', pressure: 12, openRecords: 3, locks: 2 })
    expect(await gateway.settlementQuote()).toEqual({ minAmount: 50_000n, pressure: 12, openRecords: 3, locks: 2 })
    expect(fetch.mock.calls[0][0]).toBe('https://gateway.test/v1/settlements/quote')
  })

  it('posts a chain to settle and a reclaim to their own routes', async () => {
    const fetch = stub({ signature: '5sig' })
    const chain = { issue: 'aa', spends: ['bb', 'cc'] }
    expect(await gateway.settle(chain)).toEqual({ signature: '5sig' })
    const reclaim = { ...chain, owner: 'dd', which: 1 as const, deadline: 1_900_000_000, signature: 'ee' }
    await gateway.reclaim(reclaim)
    const [settled, reclaimed] = fetch.mock.calls
    expect(settled[0]).toBe('https://gateway.test/v1/settlements')
    expect(JSON.parse(String(settled[1]?.body))).toEqual(chain)
    expect(reclaimed[0]).toBe('https://gateway.test/v1/reclaims')
    expect(JSON.parse(String(reclaimed[1]?.body))).toEqual(reclaim)
  })

  it('posts the chain of a loss to the claim route', async () => {
    const answer = { state: 'filed', hop: 2, culprit: '02aa', lock: 'Lock1', burned: '80000000', signature: '5sig' }
    const fetch = stub(answer)
    const chain = { issue: 'aa', spends: ['bb'] }
    expect(await gateway.claim(chain)).toEqual(answer)
    expect(fetch.mock.calls[0][0]).toBe('https://gateway.test/v1/fraud/claim')
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(chain)
  })

  it('keeps what a refusal said besides its message', async () => {
    stub({ error: 'horizon', retryAt: 1_900_000_000, selfPay: true }, { status: 422 })
    const refused = await gateway.settle({ issue: 'aa', spends: [] }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(GatewayError)
    expect(refused).toMatchObject({
      status: 422,
      message: 'horizon',
      body: { retryAt: 1_900_000_000, selfPay: true },
    })
  })
})

describe('private settlement requests', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('posts the request to the settlements route and returns the answer', async () => {
    const fetch = stub({ status: 'submitted' })
    const answer = await gateway.settlePrivate({ kind: 'zk' } as never)
    expect(answer).toEqual({ status: 'submitted' })
    expect(fetch.mock.calls[0][0]).toBe('https://gateway.test/v1/settlements')
  })

  it('returns a refusal the gateway answers with a status, not an error', async () => {
    stub({ status: 'refused', reason: 'stale_key' }, { status: 409 })
    expect(await gateway.settlePrivate({ kind: 'zk' } as never)).toEqual({ status: 'refused', reason: 'stale_key' })
  })

  it('throws what is not an answer', async () => {
    stub({ error: 'busy' }, { status: 503 })
    await expect(gateway.settlePrivate({ kind: 'zk' } as never)).rejects.toBeInstanceOf(GatewayError)
  })

  it('reads the keys the gateway offers', async () => {
    const fetch = stub({ current: { vkSha256: 'aa' } })
    expect(await gateway.zkConfig()).toEqual({ current: { vkSha256: 'aa' } })
    expect(fetch.mock.calls[0][0]).toBe('https://gateway.test/v1/zk-config')
  })
})
