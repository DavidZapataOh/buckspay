import { describe, expect, it } from 'vitest'
import { GRACE } from '../../protocol'
import { chainKeysOf, createKeyResolver } from './trusted-key'

const keys = (n: number) => ({
  vk: new Uint8Array(32).fill(n),
  pk: new Uint8Array(32).fill(n + 1),
  dump: new Uint8Array(32).fill(n + 2),
  ccs: new Uint8Array(32).fill(n + 3),
})
const hex = (n: number) => n.toString(16).padStart(2, '0').repeat(32)
const offer = (n: number) => ({
  vkSha256: hex(n),
  pkSha256: hex(n + 1),
  dumpSha256: hex(n + 2),
  ccsSha256: hex(n + 3),
  pkUrl: 'https://k/pk',
  ccsUrl: 'https://k/ccs',
})

describe('chainKeysOf', () => {
  it('has no previous key before a rotation', () => {
    expect(chainKeysOf({ current: keys(10), previous: keys(0), rotatedAt: 0n })).toEqual({
      current: { vkSha256: hex(10), pkSha256: hex(11), dumpSha256: hex(12), ccsSha256: hex(13) },
    })
  })
  it('keeps the previous key for 72 hours and the grace after the rotation', () => {
    const chain = chainKeysOf({ current: keys(10), previous: keys(20), rotatedAt: 1_000n })
    expect(chain.previous?.vkSha256).toBe(hex(20))
    expect(chain.previous?.validUntil).toBe(1_000 + 72 * 3600 + GRACE)
  })
})

describe('createKeyResolver', () => {
  const chain = { current: chainKeysOf({ current: keys(10), previous: keys(0), rotatedAt: 0n }).current }
  const resolve = (over: Partial<Parameters<typeof createKeyResolver>[0]>) =>
    createKeyResolver({
      zkConfig: async () => ({ current: offer(10) }),
      readChain: async () => chain,
      pins: [],
      now: () => 0,
      ...over,
    })()

  it('offers the key the chain announces', async () => {
    expect(await resolve({})).toEqual(offer(10))
  })
  it('refuses a key the chain does not announce, whatever the gateway says', async () => {
    expect(await resolve({ zkConfig: async () => ({ current: offer(30) }) })).toBeUndefined()
  })
  it('uses the build pin only while the chain cannot be read', async () => {
    const pin = { vkSha256: hex(10), pkSha256: hex(11), dumpSha256: hex(12), ccsSha256: hex(13) }
    expect(await resolve({ readChain: async () => null, pins: [pin] })).toEqual(offer(10))
    expect(await resolve({ readChain: async () => null, pins: [] })).toBeUndefined()
  })
  it('offers nothing when the gateway cannot be reached', async () => {
    expect(
      await resolve({
        zkConfig: async () => {
          throw new Error('offline')
        },
      }),
    ).toBeUndefined()
  })
})
