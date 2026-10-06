import { hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { pinnedKey } from '../../protocol/hpke'
import vectors from '../../../gateway/tests/vectors/relay-response.json'
import { encodeInner } from './inner'
import { openResponseWith, sealRelay } from './seal'
import { openAsGateway, schedule, sealAnswer, testGatewayKey } from './testing'

const { genesis, now, config } = testGatewayKey

describe('sealing', () => {
  it('the gateway opens what the app seals, under the relay info and AAD', async () => {
    const inner = encodeInner(new Uint8Array(140), [new Uint8Array(150)])
    const sealed = await sealRelay(config, genesis, inner, now)
    expect(await openAsGateway(sealed.blob, 'relay')).toEqual(inner)
    await expect(openAsGateway(sealed.blob, 'settlement')).rejects.toThrow()
    expect(sealed.clusterTag).toEqual(genesis.slice(0, 4))
  })

  it('opens the gateway vectors and refuses a flipped byte', async () => {
    expect(vectors.length).toBeGreaterThan(0)
    for (const v of vectors) {
      expect(await openResponseWith(hexToBytes(v.secret), hexToBytes(v.enc), hexToBytes(v.sealed))).toEqual(
        JSON.parse(v.body),
      )
      const bad = hexToBytes(v.sealed)
      bad[40] ^= 1
      expect(await openResponseWith(hexToBytes(v.secret), hexToBytes(v.enc), bad)).toBeNull()
      expect(await openResponseWith(new Uint8Array(32), hexToBytes(v.enc), hexToBytes(v.sealed))).toBeNull()
    }
  })

  it('reads the answer only the payer can read, and refuses one it cannot', async () => {
    const sealed = await sealRelay(config, genesis, new Uint8Array(1024), now)
    const answer = { status: 'retry', retryAfter: 600 } as const
    expect(await sealed.openResponse(await sealAnswer(sealed.secret, sealed.blob.slice(1, 33), answer))).toEqual(answer)
    expect(await sealed.openResponse(await sealAnswer(new Uint8Array(32), sealed.blob.slice(1, 33), answer))).toBeNull()
    expect(await sealed.openResponse(new Uint8Array(64))).toBeNull()
    const odd = await sealAnswer(sealed.secret, sealed.blob.slice(1, 33), { status: 'bogus' } as never)
    expect(await sealed.openResponse(odd)).toBeNull()
  })
})

describe('pinned key schedule', () => {
  const keys = schedule()
  const listed = (list: typeof keys, fetchedAt: number) => ({ keys: list, fetchedAt })

  it('picks the pinned key whose slot contains now and skips one past its notAfter', () => {
    expect(keys).toHaveLength(13)
    expect(new Set(keys.map((key) => key.keyId)).size).toBe(13)
    expect(pinnedKey(listed(keys, 0), keys[0].notBefore + 10, keys)?.keyId).toBe(keys[0].keyId)
    expect(pinnedKey(listed(keys, 0), keys[0].notAfter + 3_700, keys)?.keyId).toBe(keys[1].keyId)
  })

  it('prefers the older slot until the next one has begun an hour ago', () => {
    expect(pinnedKey(null, keys[1].notBefore + 600, keys)?.keyId).toBe(keys[0].keyId)
    expect(pinnedKey(null, keys[1].notBefore - 600, keys)?.keyId).toBe(keys[0].keyId)
    expect(pinnedKey(null, keys[1].notBefore + 3_600, keys)?.keyId).toBe(keys[1].keyId)
  })

  it('never uses a key the build does not pin, and skips a pinned key a fresh configuration revoked', () => {
    const now = keys[0].notBefore + 10
    const foreign = { ...keys[0], keyId: 250, publicKey: new Uint8Array(32).fill(9) }
    expect(pinnedKey(listed([foreign], now), now, keys)).toBeNull()
    expect(pinnedKey(listed(keys.slice(1), now), now, keys)).toBeNull()
    const later = keys[1].notBefore + 10
    expect(pinnedKey(listed(keys.slice(1), later), later, keys)?.keyId).toBe(keys[1].keyId)
    expect(pinnedKey(listed(keys.slice(1), 0), later, keys)?.keyId).toBe(keys[0].keyId)
  })

  it('a build whose only pinned keys are retired beyond the window refuses to seal', async () => {
    const now = keys[12].notAfter + 72 * 3_600 + 1
    expect(pinnedKey(null, now, keys)).toBeNull()
    await expect(sealRelay(null, genesis, new Uint8Array(1024), now)).rejects.toThrow(/update/i)
  })
})
