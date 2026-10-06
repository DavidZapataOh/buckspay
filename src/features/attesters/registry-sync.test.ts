import { describe, expect, it } from 'vitest'
import { MINT } from '../../payment/testing/world'
import { type RegistryRead } from './registry'
import { syncRegistry } from './registry-sync'

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
