import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTE_DOMAIN } from '../../payment/testing/world'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import type { NoteChain } from '../settlement/chain'
import { createPrivateSettler } from './private-settler'
import { list, put } from './proof-store'
import { SUBMIT_SPREAD } from './policy'
import { settledChainFixture } from './testing/chain'
import type { KeyOffer } from './types'

const offer: KeyOffer = {
  vkSha256: 'ab'.repeat(32),
  pkSha256: 'p',
  ccsSha256: 'c',
  dumpSha256: 'd',
  pkUrl: 'https://k/pk',
  ccsUrl: 'https://k/ccs',
}
const outputId = new Uint8Array(32).fill(5)
const noteId = '05'.repeat(32)
const T0 = 1_000_000

async function setup(over: { keyState?: string; collected?: number[] } = {}) {
  const db = createNodeDb()
  await migrate(db)
  const prover = {
    keyStatus: vi.fn(
      async () => ({ vkSha256: offer.vkSha256, state: over.keyState ?? 'ready', progress: 0.5, sizeBytes: 0 }) as never,
    ),
    ensureKey: vi.fn(async (_offer: KeyOffer, _unmetered: boolean) => undefined),
    enqueue: vi.fn(async (_id: string, _chain: Uint8Array, _todo: number[], _vk: string, _mode: string) => undefined),
    collect: vi
      .fn()
      .mockResolvedValueOnce(
        (over.collected ?? []).map((index) => ({
          index,
          proof: new Uint8Array(192).fill(index),
          publicInputs: new Uint8Array(320),
        })),
      )
      .mockResolvedValue([]),
    acknowledge: vi.fn(async (_id: string, _vk: string, _indices: number[]) => undefined),
  }
  const gateway = { settlePrivate: vi.fn(async () => ({ status: 'settled', signature: 'sig' }) as never) }
  let clock = T0
  const settler = createPrivateSettler({
    db,
    prover,
    gateway,
    trustedKey: async () => offer,
    noteDomain: NOTE_DOMAIN,
    now: () => clock,
  })
  return { db, prover, gateway, settler, at: (t: number) => (clock = t) }
}

describe('createPrivateSettler', () => {
  let chain: NoteChain
  beforeEach(() => {
    chain = settledChainFixture(3)
  })
  const note = (userAsked = false) => ({ outputId, chain, settleBy: T0 + 10 * 86_400, userAsked })

  it('asks for the key on Wi-Fi while charging and reports how far it is', async () => {
    const t = await setup({ keyState: 'downloading' })
    expect(await t.settler.advance(note())).toEqual({ kind: 'needs-key', progress: 0.5 })
    expect(t.prover.ensureKey).toHaveBeenCalledWith(offer, true)
    expect(t.prover.enqueue).not.toHaveBeenCalled()
  })

  it('downloads on any network when the user asked', async () => {
    const t = await setup({ keyState: 'missing' })
    await t.settler.advance(note(true))
    expect(t.prover.ensureKey).toHaveBeenCalledWith(offer, false)
  })

  it('waits for the charger, enqueueing every message', async () => {
    const t = await setup()
    const total = chain.spends.length + 1
    expect(await t.settler.advance(note())).toEqual({ kind: 'waiting-for-charger', proved: 0, total })
    const [id, bytes, todo, vk, mode] = t.prover.enqueue.mock.calls[0] as unknown as [
      string,
      Uint8Array,
      number[],
      string,
      string,
    ]
    expect([id, vk, mode]).toEqual([noteId, offer.vkSha256, 'charging'])
    expect(todo).toEqual(Array.from({ length: total }, (_, i) => i))
    expect(bytes.length).toBeGreaterThan(total * 150)
  })

  it('proves at once when the user asked and near the deadline', async () => {
    const asked = await setup()
    expect((await asked.settler.advance(note(true))).kind).toBe('proving')
    expect(asked.prover.enqueue.mock.calls[0][4]).toBe('now')
    const late = await setup()
    expect(await late.settler.advance({ ...note(), settleBy: T0 + 86_400 })).toMatchObject({ kind: 'proving' })
    expect(late.prover.enqueue.mock.calls[0][4]).toBe('deadline')
  })

  it('stores the proofs the prover made, acknowledges them and enqueues only the rest', async () => {
    const t = await setup({ collected: [0, 1] })
    const state = await t.settler.advance(note())
    expect(state).toMatchObject({ kind: 'waiting-for-charger', proved: 2 })
    expect((await list(t.db, noteId)).map((p) => p.index)).toEqual([0, 1])
    expect(t.prover.acknowledge).toHaveBeenCalledWith(noteId, offer.vkSha256, [0, 1])
    expect(t.prover.enqueue.mock.calls[0][2]).toEqual([2, 3])
  })

  it('holds a finished note back by its spread, then submits without any holder key', async () => {
    const total = chain.spends.length + 1
    const t = await setup({ collected: Array.from({ length: total }, (_, i) => i) })
    expect(await t.settler.advance(note())).toEqual({ kind: 'ready' })
    expect(t.gateway.settlePrivate).not.toHaveBeenCalled()
    t.at(T0 + SUBMIT_SPREAD)
    expect(await t.settler.advance(note())).toEqual({ kind: 'settled', signature: 'sig' })
    const request = JSON.stringify(t.gateway.settlePrivate.mock.calls[0])
    expect(request).toContain('"kind":"zk"')
    expect(request).not.toContain(
      Buffer.from(chain.issue.message.owner.type === 'device' ? chain.issue.message.owner.key : []).toString('base64'),
    )
  })

  it('submits at once when the user asked', async () => {
    const total = chain.spends.length + 1
    const t = await setup({ collected: Array.from({ length: total }, (_, i) => i) })
    expect(await t.settler.advance(note(true))).toEqual({ kind: 'settled', signature: 'sig' })
  })

  it('ignores proofs made under another key', async () => {
    const t = await setup()
    await put(
      t.db,
      noteId,
      { index: 0, vkSha256: 'cd'.repeat(32), proof: new Uint8Array(192), publicInputs: new Uint8Array(320) },
      T0,
    )
    await t.settler.advance(note())
    expect(t.prover.enqueue.mock.calls[0][2]).toEqual([0, 1, 2, 3])
  })

  it('reports a failed submission as a retry and keeps the proofs', async () => {
    const total = chain.spends.length + 1
    const t = await setup({ collected: Array.from({ length: total }, (_, i) => i) })
    t.gateway.settlePrivate.mockRejectedValue(new Error('offline'))
    expect(await t.settler.advance(note(true))).toEqual({ kind: 'failed', reason: 'retry' })
    expect(await list(t.db, noteId)).toHaveLength(total)
  })

  it('does nothing without a trusted key', async () => {
    const t = await setup()
    const settler = createPrivateSettler({
      db: t.db,
      prover: t.prover,
      gateway: t.gateway,
      trustedKey: async () => undefined,
      noteDomain: NOTE_DOMAIN,
      now: () => T0,
    })
    expect(await settler.advance(note())).toEqual({ kind: 'failed', reason: 'retry' })
    expect(t.prover.keyStatus).not.toHaveBeenCalled()
  })
})
