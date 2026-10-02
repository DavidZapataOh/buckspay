import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGateway, GATEWAY_TIMEOUT_MS, notSent } from './gateway'

const gateway = createGateway('https://gateway.test')

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
    const answer = expect(gateway.sponsorship()).rejects.toThrow('aborted')
    await vi.advanceTimersByTimeAsync(GATEWAY_TIMEOUT_MS)
    await answer
  })

  it('reports a refusal with its status, and an answer that is not JSON with the status text', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: 'too many requests' }, { status: 429 }))
    await expect(gateway.sponsorship()).rejects.toMatchObject({ status: 429, message: 'too many requests' })
    vi.stubGlobal('fetch', async () => new Response('<html></html>', { status: 502, statusText: 'Bad Gateway' }))
    const proxied = await gateway.submit({ key: '', transaction: '' }).catch((error: unknown) => error)
    expect(proxied).toMatchObject({ status: 502, message: 'Bad Gateway' })
    // A proxy's 502 does not say whether the gateway sent the registration; the gateway's own refusals do.
    expect(notSent(proxied)).toBe(false)
  })
})
