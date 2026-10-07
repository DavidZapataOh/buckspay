import { readFileSync } from 'node:fs'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { getAddressDecoder } from '@solana/kit'
import { describe, expect, it, vi } from 'vitest'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import type { ClaimProverNative, KeyState } from '../zk/native'
import type { KeyOffer } from '../zk/types'
import type { ClaimRequest, JobAnswer } from './api'
import { loadLeafSecrets } from './secrets'
import {
  advanceClaims,
  CLAIM_REQUEST_BYTES,
  type ClaimContext,
  claimJobKey,
  encodeClaimRequest,
  expectedPublics,
  fetchRewardLeaves,
  recipientLimbs,
  rewardScope,
} from './secrets-claim'
import { merklePath } from './secrets-tree'

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../prover/testdata/${name}`, import.meta.url), 'utf8'))
const vectors = read('claim-vectors.json')
const fixture = read('claim-requests.json') as { index: number; request: string; publics: string }[]
const leaves: Uint8Array[] = vectors.leaves.map((hex: string) => hexToBytes(hex))
const ROOT = hexToBytes(vectors.root)
const RECIPIENT = new Uint8Array(32).fill(0xab)
const MAX_FEE = 900_000n
const KEY: KeyOffer = {
  vkSha256: 'a'.repeat(64),
  pkSha256: 'b'.repeat(64),
  ccsSha256: 'c'.repeat(64),
  dumpSha256: 'd'.repeat(64),
  pkUrl: 'p',
  ccsUrl: 'c',
}
const NOW = 10_000

const store = async () => {
  const db = createNodeDb()
  await migrate(db)
  return db
}

/** A leaf of the circuit vectors, as a stored secret that is due. */
async function seed(db: Awaited<ReturnType<typeof store>>, entry: number, patch: Record<string, unknown> = {}) {
  const d = vectors.derivations[vectors.paths[entry].index]
  const row = {
    leaf: hexToBytes(d.leaf),
    nullifier: hexToBytes(d.nullifier),
    trapdoor: hexToBytes(d.trapdoor),
    inner: hexToBytes(d.inner),
    exp: d.exp,
    epoch: 2,
    leaf_index: vectors.paths[entry].index,
    state: 'in_tree',
    claim_at: NOW - 1,
    recipient: RECIPIENT,
    recipient_secret: new Uint8Array(32).fill(9),
    created_at: 0,
    ...patch,
  }
  const columns = Object.keys(row)
  await db.run(
    `INSERT INTO leaf_secrets (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    Object.values(row) as never[],
  )
  return { leaf: row.leaf, scope: hexToBytes(d.scope) }
}

function fakes(scope: Uint8Array, overrides: Partial<ClaimContext> = {}) {
  const prover = {
    keyStatus: vi.fn(async () => ({
      vkSha256: KEY.vkSha256,
      state: 'ready' as KeyState,
      progress: 1,
      sizeBytes: 1,
    })),
    ensureKey: vi.fn(async () => undefined),
    enqueueClaim: vi.fn(async (_id: string, _request: Uint8Array, _vkSha256: string) => undefined),
    collectClaim: vi.fn(async () => null as { proof: Uint8Array; publicInputs: Uint8Array } | null),
    claimState: vi.fn(async () => ({ state: 'running', reason: '' })),
    forgetClaim: vi.fn(async () => undefined),
  } satisfies ClaimProverNative
  const submitClaims = vi.fn<(request: ClaimRequest) => Promise<JobAnswer>>(async () => ({
    status: 'submitted',
    jobKey: 'job-1',
  }))
  const claimStatus = vi.fn<(jobKey: string) => Promise<JobAnswer>>(async () => ({ status: 'submitted' }))
  const ctx: ClaimContext = {
    now: NOW,
    scope,
    maxFee: MAX_FEE,
    tree: async () => ({ leaves, root: ROOT }),
    latestRoot: async () => ROOT,
    key: async () => KEY,
    prover,
    gateway: { submitClaims, claimStatus },
    ...overrides,
  }
  return { prover, submitClaims, claimStatus, ctx }
}

const proved = (entry: number) => ({
  proof: new Uint8Array(128).fill(3),
  publicInputs: hexToBytes(fixture[entry].publics),
})

describe('claim request', () => {
  it('is the request the Go prover reads, byte for byte, and states the public inputs the prover derives', () => {
    expect(fixture.length).toBe(vectors.paths.length)
    for (const f of fixture) {
      const d = vectors.derivations[f.index]
      const path = merklePath(leaves, f.index)
      const request = encodeClaimRequest({
        root: path.root,
        scope: hexToBytes(d.scope),
        recipient: RECIPIENT,
        maxFee: MAX_FEE,
        exp: d.exp,
        nullifier: hexToBytes(d.nullifier),
        trapdoor: hexToBytes(d.trapdoor),
        index: f.index,
        siblings: path.siblings,
      })
      expect(request.length).toBe(CLAIM_REQUEST_BYTES)
      expect(bytesToHex(request)).toBe(f.request)
      const publics = expectedPublics(
        { nullifier: hexToBytes(d.nullifier), exp: d.exp },
        path.root,
        hexToBytes(d.scope),
        RECIPIENT,
        MAX_FEE,
      )
      expect(bytesToHex(publics)).toBe(f.publics)
    }
  })

  it('refuses every field the prover would refuse', () => {
    const path = merklePath(leaves, 0)
    const d = vectors.derivations[0]
    const ok = {
      root: path.root,
      scope: hexToBytes(d.scope),
      recipient: RECIPIENT,
      maxFee: MAX_FEE,
      exp: 1,
      nullifier: hexToBytes(d.nullifier),
      trapdoor: hexToBytes(d.trapdoor),
      index: 0,
      siblings: path.siblings,
    }
    expect(() => encodeClaimRequest(ok)).not.toThrow()
    expect(() => encodeClaimRequest({ ...ok, siblings: path.siblings.slice(1) })).toThrow('siblings')
    expect(() => encodeClaimRequest({ ...ok, maxFee: 1n << 128n })).toThrow('maximum fee')
    expect(() => encodeClaimRequest({ ...ok, exp: 8 })).toThrow('exponent')
    expect(() => encodeClaimRequest({ ...ok, index: 2 ** 20 })).toThrow('outside the tree')
    expect(() => encodeClaimRequest({ ...ok, nullifier: new Uint8Array(32).fill(0xff) })).toThrow('nullifier')
    expect(() => encodeClaimRequest({ ...ok, recipient: new Uint8Array(31) })).toThrow('recipient')
  })

  it('binds a proof to the mint, program and cluster through the scope, and splits the recipient in two limbs', () => {
    const scope = rewardScope(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), new Uint8Array(32).fill(3))
    // sha256("buckspay/reward" || 32x01 || 32x02 || 32x03) mod r, computed with Python's hashlib.
    expect(bytesToHex(scope)).toBe('0c6291f54f218bbff2ad933a86054baad6fbdf9ce85b25bd66c8b778b772d3f0')
    expect(rewardScope(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), new Uint8Array(32).fill(4))).not.toEqual(
      scope,
    )
    const [hi, lo] = recipientLimbs(Uint8Array.from({ length: 32 }, (_, i) => i + 1))
    expect(bytesToHex(hi)).toBe(`${'00'.repeat(16)}0102030405060708090a0b0c0d0e0f10`)
    expect(bytesToHex(lo)).toBe(`${'00'.repeat(16)}1112131415161718191a1b1c1d1e1f20`)
  })

  it('names a claim by the hash of its nullifier hash, as the gateway does', () => {
    expect(claimJobKey(new Uint8Array(32))).toBe('66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925')
  })
})

describe('advancing claims', () => {
  it('proves a due leaf against the latest root of its tree and posts it, then watches it settle', async () => {
    const db = await store()
    const { leaf, scope } = await seed(db, 1)
    const { prover, submitClaims, claimStatus, ctx } = fakes(scope)
    expect(await advanceClaims(db, ctx)).toMatchObject({ enqueued: 1 })
    expect(prover.enqueueClaim).toHaveBeenCalledWith(bytesToHex(leaf), expect.any(Uint8Array), KEY.vkSha256)
    expect(bytesToHex(prover.enqueueClaim.mock.calls[0][1])).toBe(fixture[1].request)
    expect((await loadLeafSecrets(db))[0].state).toBe('proving')

    prover.collectClaim.mockResolvedValueOnce(proved(1))
    expect(await advanceClaims(db, ctx)).toMatchObject({ submitted: 1 })
    expect(submitClaims).toHaveBeenCalledOnce()
    const sent = submitClaims.mock.calls[0][0]
    expect(sent).toMatchObject({ maxFee: 900_000, recipient: getAddressDecoder().decode(RECIPIENT) })
    expect(sent.claims[0]).toMatchObject({ epoch: 2, exp: 5 })
    expect(sent.claims[0].root).toBe(btoa(String.fromCharCode(...ROOT)))
    expect(prover.forgetClaim).toHaveBeenCalled()
    const submitted = (await loadLeafSecrets(db))[0]
    expect(submitted).toMatchObject({ state: 'submitted', jobKey: 'job-1', error: null })

    claimStatus.mockResolvedValueOnce({ status: 'submitted' })
    expect(await advanceClaims(db, ctx)).toMatchObject({ claimed: 0 })
    claimStatus.mockResolvedValueOnce({ status: 'settled', signature: 'sig' })
    expect(await advanceClaims(db, ctx)).toMatchObject({ claimed: 1 })
    expect((await loadLeafSecrets(db))[0]).toMatchObject({ state: 'claimed', signature: 'sig' })
  })

  it('names the claim by its nullifier hash when the gateway gives no key', async () => {
    const db = await store()
    const { scope } = await seed(db, 1, { state: 'proving' })
    const { prover, submitClaims, ctx } = fakes(scope)
    prover.collectClaim.mockResolvedValue(proved(1))
    submitClaims.mockResolvedValue({ status: 'duplicate' })
    await advanceClaims(db, ctx)
    const nullifierHash = hexToBytes(fixture[1].publics).slice(32, 64)
    expect((await loadLeafSecrets(db))[0].jobKey).toBe(claimJobKey(nullifierHash))
  })

  it('waits for the time of the claim, and for the user to choose one', async () => {
    const db = await store()
    const { scope } = await seed(db, 1, { claim_at: NOW + 1 })
    await seed(db, 2, { claim_at: null, exp: 1 })
    const { prover, ctx } = fakes(scope)
    expect(await advanceClaims(db, ctx)).toMatchObject({ waiting: 2, enqueued: 0 })
    expect(prover.enqueueClaim).not.toHaveBeenCalled()
  })

  it('makes a fresh recipient once and keeps it', async () => {
    const db = await store()
    const { scope } = await seed(db, 1, { recipient: null, recipient_secret: null })
    const { prover, ctx } = fakes(scope)
    await advanceClaims(db, ctx)
    const [first] = await loadLeafSecrets(db)
    expect(first.recipient).toHaveLength(32)
    expect(first.recipientSecret).toHaveLength(32)
    await db.run("UPDATE leaf_secrets SET state = 'in_tree'")
    await advanceClaims(db, ctx)
    expect((await loadLeafSecrets(db))[0].recipient).toEqual(first.recipient)
    expect(prover.enqueueClaim).toHaveBeenCalledTimes(2)
  })

  it('says why it cannot start: no trusted key, a key still downloading, a tree that disagrees with the chain, a prover that throws', async () => {
    const db = await store()
    const { scope } = await seed(db, 1)
    const errorOf = async () => (await loadLeafSecrets(db))[0]
    await advanceClaims(db, fakes(scope, { key: async () => undefined }).ctx)
    expect((await errorOf()).error).toBe('No trusted claim key is available yet.')

    const downloading = fakes(scope)
    downloading.prover.keyStatus.mockResolvedValue({
      vkSha256: KEY.vkSha256,
      state: 'downloading',
      progress: 0.2,
      sizeBytes: 1,
    })
    await advanceClaims(db, downloading.ctx)
    expect(downloading.prover.ensureKey).toHaveBeenCalledWith(KEY, true)
    expect((await errorOf()).error).toBe('The claim key is downloading.')

    const wrongRoot = fakes(scope, { tree: async () => ({ leaves, root: new Uint8Array(32).fill(1) }) })
    await advanceClaims(db, wrongRoot.ctx)
    expect(wrongRoot.prover.enqueueClaim).not.toHaveBeenCalled()
    expect(await errorOf()).toMatchObject({
      state: 'in_tree',
      error: 'The reward tree data does not match the root on the chain.',
    })

    const unreachable = fakes(scope, { tree: async () => Promise.reject(new Error('The gateway answered 503.')) })
    await advanceClaims(db, unreachable.ctx)
    expect((await errorOf()).error).toBe('The gateway answered 503.')

    const broken = fakes(scope)
    broken.prover.enqueueClaim.mockRejectedValue(new Error('work manager is gone'))
    await advanceClaims(db, broken.ctx)
    expect(await errorOf()).toMatchObject({ state: 'in_tree', error: 'work manager is gone' })
  })

  it('fails a leaf the tree does not hold', async () => {
    const db = await store()
    const { scope } = await seed(db, 1)
    const other = leaves.map((leaf, i) => (i === vectors.paths[1].index ? new Uint8Array(32).fill(5) : leaf))
    const { ctx } = fakes(scope, { tree: async () => ({ leaves: other, root: merklePath(other, 0).root }) })
    expect(await advanceClaims(db, ctx)).toMatchObject({ failed: 1 })
    expect((await loadLeafSecrets(db))[0]).toMatchObject({
      state: 'failed',
      error: 'The reward tree does not hold this leaf.',
    })
  })

  it('refuses a proof that does not state this claim and posts nothing', async () => {
    const db = await store()
    const { scope } = await seed(db, 1, { state: 'proving' })
    const tampered = proved(1)
    tampered.publicInputs[40] ^= 1
    const { prover, submitClaims, ctx } = fakes(scope)
    prover.collectClaim.mockResolvedValue(tampered)
    expect(await advanceClaims(db, ctx)).toMatchObject({ failed: 1 })
    expect(submitClaims).not.toHaveBeenCalled()
    expect((await loadLeafSecrets(db))[0]).toMatchObject({
      state: 'failed',
      error: 'The proof does not state this claim.',
    })
    const short = fakes(scope)
    await db.run("UPDATE leaf_secrets SET state = 'proving'")
    short.prover.collectClaim.mockResolvedValue({
      proof: new Uint8Array(100),
      publicInputs: hexToBytes(fixture[1].publics),
    })
    await advanceClaims(db, short.ctx)
    expect(short.submitClaims).not.toHaveBeenCalled()
  })

  it('proves again, and posts nothing, when the tree moved on while it proved', async () => {
    const db = await store()
    const { scope } = await seed(db, 1, { state: 'proving' })
    const { prover, submitClaims, ctx } = fakes(scope, { latestRoot: async () => new Uint8Array(32).fill(7) })
    prover.collectClaim.mockResolvedValue(proved(1))
    await advanceClaims(db, ctx)
    expect(submitClaims).not.toHaveBeenCalled()
    expect((await loadLeafSecrets(db))[0]).toMatchObject({
      state: 'in_tree',
      claimAt: NOW,
      error: 'The reward tree moved on; proving again.',
    })
  })

  it.each([
    [{ status: 'duplicate', jobKey: 'j' } as JobAnswer, { state: 'submitted', error: null, job_key: 'j' }],
    [{ status: 'settled', signature: 'sig' } as JobAnswer, { state: 'claimed', signature: 'sig' }],
    [
      { status: 'retry', retryAfter: 120 } as JobAnswer,
      { state: 'in_tree', error: 'The gateway asked to try again later.', claim_at: NOW + 120 },
    ],
    [{ status: 'retry', retryAfter: 0 } as JobAnswer, { state: 'in_tree', claim_at: NOW + 3_600 }],
    [
      { status: 'refused', reason: 'stale_key' } as JobAnswer,
      { state: 'in_tree', error: 'The claim key changed; proving again.', claim_at: NOW },
    ],
    [
      { status: 'refused', reason: 'spent' } as JobAnswer,
      { state: 'failed', error: 'This reward was already claimed.' },
    ],
    [
      { status: 'refused', reason: 'fee' } as JobAnswer,
      { state: 'failed', error: 'The claim fee is above what this reward allows.' },
    ],
    [
      { status: 'refused', reason: 'invalid' } as JobAnswer,
      { state: 'failed', error: 'The gateway refused this claim as invalid.' },
    ],
  ])('keeps what the gateway answered %j on the leaf', async (answer, expected) => {
    const db = await store()
    const { scope } = await seed(db, 1, { state: 'proving' })
    const { prover, submitClaims, ctx } = fakes(scope)
    prover.collectClaim.mockResolvedValue(proved(1))
    submitClaims.mockResolvedValue(answer)
    await advanceClaims(db, ctx)
    const [row] = await db.all<Record<string, unknown>>(
      'SELECT state, error, claim_at, job_key, signature FROM leaf_secrets',
    )
    expect(row).toMatchObject(expected)
    expect(prover.forgetClaim).toHaveBeenCalled()
  })

  it('keeps a proved claim when the gateway cannot be reached, and posts it again next time', async () => {
    const db = await store()
    const { scope } = await seed(db, 1, { state: 'proving' })
    const { prover, submitClaims, ctx } = fakes(scope)
    prover.collectClaim.mockResolvedValue(proved(1))
    submitClaims.mockRejectedValueOnce(new Error('The gateway answered 502.'))
    await advanceClaims(db, ctx)
    expect((await loadLeafSecrets(db))[0]).toMatchObject({ state: 'proving', error: 'The gateway answered 502.' })
    expect(prover.forgetClaim).not.toHaveBeenCalled()
    await advanceClaims(db, ctx)
    expect((await loadLeafSecrets(db))[0]).toMatchObject({ state: 'submitted', error: null })
  })

  it('fails a posted claim the gateway later refuses, and keeps waiting while it is pending', async () => {
    const db = await store()
    const { scope } = await seed(db, 1, { state: 'submitted', job_key: 'j' })
    const { claimStatus, ctx } = fakes(scope)
    await advanceClaims(db, ctx)
    expect((await loadLeafSecrets(db))[0].state).toBe('submitted')
    claimStatus.mockResolvedValue({ status: 'refused', reason: 'spent' })
    await advanceClaims(db, ctx)
    expect((await loadLeafSecrets(db))[0]).toMatchObject({ state: 'failed', error: 'This reward was already claimed.' })
  })

  it.each([
    [
      { state: 'failed', reason: 'invalid' },
      { state: 'failed', error: 'The prover refused this claim.' },
    ],
    [
      { state: 'failed', reason: 'no-key' },
      { state: 'in_tree', error: 'The claim key is missing; proving again.' },
    ],
    [
      { state: 'cancelled', reason: '' },
      { state: 'in_tree', error: 'Proving was interrupted; proving again.' },
    ],
    [
      { state: 'unknown', reason: '' },
      { state: 'in_tree', error: 'Proving was interrupted; proving again.' },
    ],
    [
      { state: 'running', reason: '' },
      { state: 'proving', error: null },
    ],
  ])('reads the prover state %j', async (state, expected) => {
    const db = await store()
    const { scope } = await seed(db, 1, { state: 'proving' })
    const { prover, ctx } = fakes(scope)
    prover.claimState.mockResolvedValue(state)
    await advanceClaims(db, ctx)
    const [row] = await db.all<Record<string, unknown>>('SELECT state, error FROM leaf_secrets')
    expect(row).toMatchObject(expected)
  })
})

describe('reward leaves from the gateway', () => {
  it('reads 32 bytes per leaf and refuses a body that is not whole leaves or an answer that is not ok', async () => {
    const body = new Uint8Array([...leaves[0], ...leaves[1]])
    const ok = vi.fn(async () => new Response(body as BodyInit))
    const read = await fetchRewardLeaves('https://gw.test', ok as never)(7)
    expect(read.map(bytesToHex)).toEqual([bytesToHex(leaves[0]), bytesToHex(leaves[1])])
    expect(ok.mock.calls[0]).toEqual(['https://gw.test/v1/rewards/trees/7'])
    await expect(
      fetchRewardLeaves('https://gw.test', vi.fn(async () => new Response(new Uint8Array(40) as BodyInit)) as never)(7),
    ).rejects.toThrow('malformed')
    await expect(
      fetchRewardLeaves('https://gw.test', vi.fn(async () => new Response('no', { status: 404 })) as never)(7),
    ).rejects.toThrow('404')
  })
})
