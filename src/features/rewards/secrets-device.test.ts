import { readFileSync } from 'node:fs'
import { hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it, vi } from 'vitest'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import type { ClaimProverNative, KeyState } from '../zk/native'
import { loadLeafSecrets } from './secrets'
import { createRewardsRoute, type RewardChain } from './secrets-device'

const vectors = JSON.parse(
  readFileSync(new URL('../../../prover/testdata/claim-vectors.json', import.meta.url), 'utf8'),
)
const hashes = {
  vkSha256: 'a'.repeat(64),
  pkSha256: 'b'.repeat(64),
  ccsSha256: 'c'.repeat(64),
  dumpSha256: 'd'.repeat(64),
}
const offer = { ...hashes, pkUrl: 'https://k/pk', ccsUrl: 'https://k/ccs' }
const leafBytes = vectors.leaves.map((leaf: string) => hexToBytes(leaf))

const prover = () =>
  ({
    keyStatus: vi.fn(async () => ({
      vkSha256: hashes.vkSha256,
      state: 'ready' as KeyState,
      progress: 1,
      sizeBytes: 1,
    })),
    ensureKey: vi.fn(async () => undefined),
    enqueueClaim: vi.fn(async (_id: string, _request: Uint8Array, _vkSha256: string) => undefined),
    collectClaim: vi.fn(async () => null),
    claimState: vi.fn(async () => ({ state: 'running', reason: '' })),
    forgetClaim: vi.fn(async () => undefined),
  }) satisfies ClaimProverNative

async function setup({
  chainKeys = null as Awaited<ReturnType<RewardChain['claimKeys']>>,
  pins = [] as (typeof hashes)[],
  serve = defaultServe,
  leafCount = leafBytes.length,
} = {}) {
  const db = createNodeDb()
  await migrate(db)
  const d = vectors.derivations[5]
  await db.run(
    "INSERT INTO leaf_secrets (leaf, nullifier, trapdoor, inner, exp, state, created_at) VALUES (?, ?, ?, ?, ?, 'made', 0)",
    [hexToBytes(d.leaf), hexToBytes(d.nullifier), hexToBytes(d.trapdoor), hexToBytes(d.inner), d.exp],
  )
  const chain: RewardChain = {
    mint: async () => ({ epoch: 3, maxFee: 900_000n, unit: 490_000n }),
    tree: async () => ({ root: hexToBytes(vectors.root), leafCount }),
    claimKeys: async () => chainKeys,
  }
  const native = prover()
  const request = vi.fn(async (url: string | URL | Request) => serve(String(url)))
  const route = createRewardsRoute({
    chain,
    programId: new Uint8Array(32).fill(1),
    mint: new Uint8Array(32).fill(2),
    gatewayUrl: 'https://gw.test',
    gateway: { submitClaims: vi.fn(), claimStatus: vi.fn() },
    genesisHash: new Uint8Array(32).fill(3),
    pins,
    prover: native,
    now: () => 50,
    request: request as never,
  })
  return { db, native, request, route }
}

function defaultServe(url: string) {
  if (url.endsWith('/v1/rewards/key')) return new Response(JSON.stringify(offer))
  return new Response(new Uint8Array(leafBytes.flatMap((leaf: Uint8Array) => [...leaf])) as BodyInit)
}

const schedule = (db: Awaited<ReturnType<typeof setup>>['db']) => db.run('UPDATE leaf_secrets SET claim_at = 0')

describe('rewards route', () => {
  it('reads the unit from the chain', async () => {
    expect(await (await setup()).route.unit()).toBe(490_000n)
  })

  it('finds its new leaf in the current epoch and leaves it for the user to claim', async () => {
    const { db, native, route } = await setup({ pins: [hashes] })
    expect(await route.advance(db)).toMatchObject({ enqueued: 0, waiting: 1 })
    expect((await loadLeafSecrets(db))[0]).toMatchObject({ state: 'in_tree', epoch: 3, leafIndex: 5, claimAt: null })
    expect(native.enqueueClaim).not.toHaveBeenCalled()
  })

  it('proves a scheduled leaf with a key the build pinned, or the chain announces', async () => {
    for (const setupOptions of [{ pins: [hashes] }, { chainKeys: { current: hashes } }]) {
      const { db, native, route } = await setup(setupOptions)
      await route.advance(db)
      await schedule(db)
      expect(await route.advance(db)).toMatchObject({ enqueued: 1 })
      expect(native.enqueueClaim).toHaveBeenCalledOnce()
    }
  })

  it('does not use a claim key neither the build nor the chain vouches for', async () => {
    const { db, native, route } = await setup()
    await route.advance(db)
    await schedule(db)
    await route.advance(db)
    expect(native.keyStatus).not.toHaveBeenCalled()
    expect((await loadLeafSecrets(db))[0].error).toBe('No trusted claim key is available yet.')
  })

  it('does nothing for a phone that never made a leaf', async () => {
    const { db, request, route } = await setup()
    await db.run('DELETE FROM leaf_secrets')
    expect(await route.advance(db)).toEqual({ enqueued: 0, submitted: 0, claimed: 0, failed: 0, waiting: 0 })
    expect(request).not.toHaveBeenCalled()
  })

  it('tells when the gateway is unreachable or its tree is behind the chain', async () => {
    const down = await setup({ serve: () => new Response('no', { status: 503 }) })
    await expect(down.route.advance(down.db)).rejects.toThrow('503')
    const behind = await setup({ leafCount: leafBytes.length + 1 })
    await expect(behind.route.advance(behind.db)).rejects.toThrow('behind the chain')
  })
})
