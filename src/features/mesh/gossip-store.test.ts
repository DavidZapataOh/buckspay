import { describe, expect, it } from 'vitest'
import { encodeIssueConflict, encodeSpendConflict } from '../../protocol'
import { FrameKind } from './frame'
import { passedThrough } from '../../payment/testing/chain'
import { NOW, party, receiverFor } from '../../payment/testing/world'
import { Reason } from '../../payment/reasons'
import { acceptPayment } from '../../payment/receive'
import { encodeBundle } from '../../payment/messages'
import {
  acceptConflict,
  countFlagged,
  flaggedGate,
  flaggedSigners,
  heldWithFlagged,
  isFlagged,
  promotePooled,
  recordConflict,
  toAdvertise,
  withoutFlagged,
} from './gossip'
import {
  conflictFor,
  freshSigner,
  issueConflictFor,
  holdChainSignedBy,
  noteDomain,
  openTestDb,
} from './testing/conflicts'

const accept = (s: ReturnType<typeof freshSigner>) => {
  const wire = encodeSpendConflict(conflictFor(s))
  const a = acceptConflict(noteDomain, 'spend', wire)
  if (!a.ok) throw new Error('fixture')
  return { a, wire }
}

describe('flags and the pool', () => {
  it('flags a known key and only pools an unknown one', async () => {
    const db = await openTestDb()
    const known = freshSigner()
    await holdChainSignedBy(db, known)
    const k = accept(known)
    const u = accept(freshSigner())
    expect(await recordConflict(db, { ...k.a, known: true }, k.wire, 'mesh', 1)).toBe('flagged')
    expect(await recordConflict(db, { ...u.a, known: false }, u.wire, 'mesh', 1)).toBe('pooled')
    expect(await isFlagged(db, known.key)).toBe(true)
    expect(await isFlagged(db, u.a.key)).toBe(false)
  })

  it('the same proof twice is a duplicate', async () => {
    const db = await openTestDb()
    const s = freshSigner()
    await holdChainSignedBy(db, s)
    const { a, wire } = accept(s)
    await recordConflict(db, { ...a, known: true }, wire, 'mesh', 1)
    expect(await recordConflict(db, { ...a, known: true }, wire, 'mesh', 2)).toBe('duplicate')
  })

  it('promotes a pooled proof when its key becomes known', async () => {
    const db = await openTestDb()
    const s = freshSigner()
    const { a, wire } = accept(s)
    await recordConflict(db, { ...a, known: false }, wire, 'mesh', 1)
    expect(await promotePooled(db, s.key)).toBe(true)
    expect(await isFlagged(db, s.key)).toBe(true)
    expect(await promotePooled(db, s.key)).toBe(false)
  })

  it('advertises at most four, known keys first, and stops after thirty minutes', async () => {
    const db = await openTestDb()
    for (let i = 0; i < 5; i++) {
      const { a, wire } = accept(freshSigner())
      await recordConflict(db, { ...a, known: false }, wire, 'mesh', 100)
    }
    const s = freshSigner()
    await holdChainSignedBy(db, s)
    const k = accept(s)
    await recordConflict(db, { ...k.a, known: true }, k.wire, 'mesh', 100)
    const now = await toAdvertise(db, 100, 4)
    expect(now).toHaveLength(4)
    expect(now[0].frame.payload).toEqual(k.wire)
    expect(await toAdvertise(db, 100 + 30 * 60 - 1, 4)).toHaveLength(4)
    expect(await toAdvertise(db, 100 + 30 * 60, 4)).toHaveLength(4)
    expect(await toAdvertise(db, 100 + 30 * 60 + 1, 4)).toHaveLength(0)
  })

  it('advertises the newest of the proofs of keys it has not met first', async () => {
    const db = await openTestDb()
    const [older, newer] = [accept(freshSigner()), accept(freshSigner())]
    await recordConflict(db, { ...older.a, known: false }, older.wire, 'mesh', 1)
    await recordConflict(db, { ...newer.a, known: false }, newer.wire, 'mesh', 2)
    const [first] = await toAdvertise(db, 3, 1)
    expect(first.frame.payload).toEqual(newer.wire)
  })

  it('keeps the pool at 256 rows, evicting the oldest unknown-key proof first', { timeout: 30_000 }, async () => {
    const db = await openTestDb()
    const s = freshSigner()
    await holdChainSignedBy(db, s)
    const k = accept(s)
    await recordConflict(db, { ...k.a, known: true }, k.wire, 'mesh', 0)
    for (let i = 1; i <= 260; i++) {
      const { a, wire } = accept(freshSigner())
      await recordConflict(db, { ...a, known: false }, wire, 'mesh', i)
    }
    const [{ n }] = await db.all<{ n: number }>('SELECT count(*) AS n FROM conflict_pool')
    expect(n).toBe(256)
    expect(await isFlagged(db, s.key)).toBe(true)
    expect((await toAdvertise(db, 260, 4))[0].frame.payload).toEqual(k.wire)
  })

  it('stores the kind of proof a key was flagged with, and advertises each kind as its own frame', async () => {
    const db = await openTestDb()
    const [s, t] = [freshSigner(), freshSigner()]
    const spend = encodeSpendConflict(conflictFor(s))
    const issue = encodeIssueConflict(issueConflictFor(t))
    for (const [kind, wire] of [
      ['spend', spend],
      ['issue', issue],
    ] as const) {
      const a = acceptConflict(noteDomain, kind, wire)
      if (!a.ok) throw new Error('fixture')
      await recordConflict(db, { ...a, known: true }, wire, 'mesh', 5)
    }
    const kinds = await db.all<{ kind: string }>('SELECT kind FROM flagged_keys ORDER BY kind')
    expect(kinds.map((row) => row.kind)).toEqual(['issue', 'spend'])
    const frames = (await toAdvertise(db, 5, 4)).map(({ frame }) => frame.kind).sort()
    expect(frames).toEqual([FrameKind.SpendConflict, FrameKind.IssueConflict])
    expect(await countFlagged(db)).toBe(2)
  })

  it('never expires a flag', async () => {
    const db = await openTestDb()
    const s = freshSigner()
    const { a, wire } = accept(s)
    await recordConflict(db, { ...a, known: true }, wire, 'mesh', 1)
    await toAdvertise(db, 10 ** 9, 4)
    expect(await isFlagged(db, s.key)).toBe(true)
  })
})

describe('the receive refusal', () => {
  it('names every flagged signer of a chain, at any hop', async () => {
    const db = await openTestDb()
    const culprit = freshSigner()
    const { a, wire } = accept(culprit)
    await recordConflict(db, { ...a, known: true }, wire, 'mesh', 1)
    const chain = passedThrough(freshSigner(), [freshSigner(), culprit, party(8)])
    const bundle = { ...chain, tickets: [] }
    expect(await flaggedSigners(db, bundle)).toEqual([culprit.key])
    const clean = { ...passedThrough(freshSigner(), [freshSigner(), party(8)]), tickets: [] }
    expect(await flaggedSigners(db, clean)).toEqual([])
  })

  it('the gate refuses a chain with a flagged signer and promotes a pooled proof of a key it sees', async () => {
    const db = await openTestDb()
    const culprit = freshSigner()
    const { a, wire } = accept(culprit)
    await recordConflict(db, { ...a, known: false }, wire, 'mesh', 1)
    const bundle = { ...passedThrough(freshSigner(), [freshSigner(), culprit, party(8)]), tickets: [] }
    const gate = flaggedGate(db)
    const received = {} as never
    expect(await gate.admit(received, bundle)).toBe(Reason.KeyFlagged)
    expect(await isFlagged(db, culprit.key)).toBe(true)
  })

  it('refuses a payment whose issuer is flagged and accepts the same payment otherwise', async () => {
    const issuerKey = freshSigner()
    const me = party(2)
    const ctx = async (flag: boolean) => {
      const db = await openTestDb()
      if (flag) {
        const { a, wire } = accept(issuerKey)
        await recordConflict(db, { ...a, known: true }, wire, 'mesh', 1)
      }
      return {
        receiver: receiverFor(me, { now: NOW }),
        db,
        limits: { maxPayment: 10n ** 12n },
        transport: 'qr',
        request: null,
        gate: flaggedGate(db),
      }
    }
    const { signedPayment } = await import('./testing/payments')
    const payload = encodeBundle(signedPayment(issuerKey, me))
    expect(await acceptPayment(payload, await ctx(true))).toMatchObject({ accepted: false, reason: Reason.KeyFlagged })
    expect((await acceptPayment(payload, await ctx(false))).accepted).toBe(true)
  })

  it('names a signer once even when it appears twice in a chain', async () => {
    const db = await openTestDb()
    const culprit = freshSigner()
    const { a, wire } = accept(culprit)
    await recordConflict(db, { ...a, known: true }, wire, 'mesh', 1)
    const bundle = { ...passedThrough(culprit, [culprit, party(8)]), tickets: [] }
    expect(await flaggedSigners(db, bundle)).toEqual([culprit.key])
  })

  it('leaves out of what can be passed on the notes with a flagged signer', async () => {
    const db = await openTestDb()
    const culprit = freshSigner()
    const { a, wire } = accept(culprit)
    await recordConflict(db, { ...a, known: true }, wire, 'mesh', 1)
    const flagged = { bundle: { ...passedThrough(freshSigner(), [culprit, party(8)]), tickets: [] } }
    const clean = { bundle: { ...passedThrough(freshSigner(), [party(8)]), tickets: [] } }
    expect(await withoutFlagged(db, [flagged, clean])).toEqual([clean])
  })

  it('also lists a flagged note that is already settling', async () => {
    const db = await openTestDb()
    const note = await holdChainSignedBy(db, freshSigner(), { flag: true })
    await db.run("UPDATE received_note SET state = 'settling' WHERE output_id = ?", [note.outputId])
    expect((await heldWithFlagged(db)).map((held) => held.outputId)).toEqual([note.outputId])
  })

  it('lists the held notes whose chain has a flagged signer', async () => {
    const db = await openTestDb()
    const culprit = freshSigner()
    const flagged = await holdChainSignedBy(db, culprit, { flag: true })
    await holdChainSignedBy(db, freshSigner())
    const held = await heldWithFlagged(db)
    expect(held.map((h) => h.outputId)).toEqual([flagged.outputId])
  })
})
