import { afterEach, describe, expect, it, vi } from 'vitest'
import { MINT } from '../../payment/testing/world'
import { type RegistryRead } from './registry'
import { syncRegistry, syncUntilUsable, withTimeout } from './registry-sync'

const bytes = (n: number) => new Uint8Array(32).fill(n)
const trusted = { id: 1, authority: bytes(1), mint: MINT }
const read: RegistryRead = {
  authority: bytes(1),
  mint: MINT,
  key: bytes(3),
  prevKey: bytes(0),
  prevTrustedUntil: 0,
  status: 1,
  bondFree: 1_000_000n,
}
const reader = (value: RegistryRead | undefined | Error) => async () => {
  if (value instanceof Error) throw value
  return value
}

describe('syncing the attesters a wallet trusts', () => {
  it('believes an attester both providers describe the same way', async () => {
    const attesters = await syncRegistry({ trusted: [trusted], readers: [reader(read), reader(read)], now: 100 })
    expect(attesters).toHaveLength(1)
    expect(attesters[0]).toMatchObject({ id: 1, stake: 1_000_000n, active: true, syncedAt: 100 })
  })

  it('needs two providers', async () => {
    expect(await syncRegistry({ trusted: [trusted], readers: [reader(read)], now: 100 })).toEqual([])
  })

  it('drops an attester the providers disagree on, or one that is not registered', async () => {
    const other = { ...read, key: bytes(4) }
    expect(await syncRegistry({ trusted: [trusted], readers: [reader(read), reader(other)], now: 1 })).toEqual([])
    expect(await syncRegistry({ trusted: [trusted], readers: [reader(undefined), reader(undefined)], now: 1 })).toEqual(
      [],
    )
  })

  it('keeps what it believed, with its old time, when a provider cannot be reached', async () => {
    const previous = await syncRegistry({ trusted: [trusted], readers: [reader(read), reader(read)], now: 100 })
    const offline = reader(new Error('offline'))
    const synced = await syncRegistry({ trusted: [trusted], readers: [reader(read), offline], now: 500, previous })
    expect(synced).toEqual(previous)
    expect(synced[0].syncedAt).toBe(100)
  })

  it('carries what the wallet relies on and the keys it saw revoked across a sync', async () => {
    const first = await syncRegistry({ trusted: [trusted], readers: [reader(read), reader(read)], now: 100 })
    const previous = [{ ...first[0], relied: 9n }]
    const synced = await syncRegistry({ trusted: [trusted], readers: [reader(read), reader(read)], now: 200, previous })
    expect(synced[0]).toMatchObject({ relied: 9n, syncedAt: 200 })
  })
})

describe('a registry read that never answers', () => {
  afterEach(() => vi.useRealTimers())

  it('gives up after the limit instead of holding the sync for ever', async () => {
    vi.useFakeTimers()
    const hung = withTimeout(() => new Promise<never>(() => {}), 10_000)
    const outcome = hung(1).then(
      () => 'answered',
      (error: Error) => error.message,
    )
    await vi.advanceTimersByTimeAsync(9_999)
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe('RegistryTimeout')
  })

  it('passes an answer that comes in time and leaves no timer behind', async () => {
    vi.useFakeTimers()
    expect(await withTimeout(reader(read), 10_000)(1)).toEqual(read)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes on a failure of the reader itself', async () => {
    await expect(withTimeout(reader(new Error('down')), 10_000)(1)).rejects.toThrow('down')
  })
})

describe('keeping what was believed when a provider fails', () => {
  it('keeps the cached attester when one provider cannot be reached', async () => {
    const cached = await syncRegistry({ trusted: [trusted], readers: [reader(read), reader(read)], now: 100 })
    const again = await syncRegistry({
      trusted: [trusted],
      readers: [reader(read), reader(new Error('timeout'))],
      now: 200,
      previous: cached,
    })
    expect(again).toEqual(cached)
  })

  it('has nothing to keep when the cache was not loaded yet, which is why the sync must wait for it', async () => {
    const lost = await syncRegistry({
      trusted: [trusted],
      readers: [reader(read), reader(new Error('timeout'))],
      now: 200,
      previous: [],
    })
    expect(lost).toEqual([])
  })
})

describe('syncing until the registry can be used', () => {
  const delays = [10, 20, 40]
  const never = () => false

  it('does not wait when the first sync is enough', async () => {
    const waited: number[] = []
    let usable = false
    const ok = await syncUntilUsable({
      sync: async () => void (usable = true),
      usable: () => usable,
      delays,
      wait: async (ms) => void waited.push(ms),
      stopped: never,
    })
    expect(ok).toBe(true)
    expect(waited).toEqual([])
  })

  it('tries again after a failure, waiting longer each time, and reports each failure', async () => {
    const waited: number[] = []
    const errors: string[] = []
    let calls = 0
    let usable = false
    const ok = await syncUntilUsable({
      sync: async () => {
        calls += 1
        if (calls < 3) throw new Error(`down ${calls}`)
        usable = true
      },
      usable: () => usable,
      delays,
      wait: async (ms) => void waited.push(ms),
      stopped: never,
      onError: (error) => errors.push((error as Error).message),
    })
    expect(ok).toBe(true)
    expect(calls).toBe(3)
    expect(waited).toEqual([10, 20])
    expect(errors).toEqual(['down 1', 'down 2'])
  })

  it('also tries again when the sync worked but left nothing usable', async () => {
    let calls = 0
    const ok = await syncUntilUsable({
      sync: async () => void (calls += 1),
      usable: () => calls >= 2,
      delays,
      wait: async () => {},
      stopped: never,
    })
    expect(ok).toBe(true)
    expect(calls).toBe(2)
  })

  it('stops when the delays run out', async () => {
    let calls = 0
    const ok = await syncUntilUsable({
      sync: async () => void (calls += 1),
      usable: () => false,
      delays,
      wait: async () => {},
      stopped: never,
    })
    expect(ok).toBe(false)
    expect(calls).toBe(delays.length + 1)
  })

  it('stops at once when the screen that asked for it is gone', async () => {
    let calls = 0
    let gone = false
    const ok = await syncUntilUsable({
      sync: async () => void (calls += 1),
      usable: () => false,
      delays,
      wait: async () => void (gone = true),
      stopped: () => gone,
    })
    expect(ok).toBe(false)
    expect(calls).toBe(1)
  })
})
