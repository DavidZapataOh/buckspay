import { describe, expect, it } from 'vitest'
import { CHALLENGE, EXPIRY_STEP, Flags, GRACE, NO_LOCK, verifyPayment } from '../protocol'
import { encodeBundle } from './messages'
import { planRespend, respendBundle } from './respend'
import { heldNote, NOW, party, payCtx, receiverFor, requestTo, signSpendWith } from './testing/world'

const issuer = party(1)
const me = party(2)
const bob = party(3)

const ok = <T>(r: { ok: true; plan: T } | { ok: false; reason: string }) => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`)
  return r.plan
}

describe('planRespend', () => {
  it('pays a whole output with a Spend1', () => {
    const held = [heldNote({ from: issuer, to: me, amount: 5_000_000n })]
    const plan = ok(planRespend(requestTo(bob, 5_000_000n), held, payCtx(me)))
    expect(plan.spend.outputs.type).toBe('one')
    expect(plan.review.kind).toBe('spend1')
  })

  it('pays part with a Spend2 whose change returns to me', () => {
    const held = [heldNote({ from: issuer, to: me, amount: 5_000_000n })]
    const plan = ok(planRespend(requestTo(bob, 2_000_000n), held, payCtx(me)))
    expect(plan.review).toMatchObject({ kind: 'spend2', change: 3_000_000n })
    const outputs = plan.spend.outputs
    if (outputs.type !== 'two') throw new Error('expected two outputs')
    expect(outputs.amount0).toBe(2_000_000n)
    expect(outputs.owner1).toEqual({ type: 'device', key: me.key })
  })

  it('names my own lock and never NO_LOCK', () => {
    const held = [heldNote({ from: issuer, to: me, amount: 1_000_000n })]
    const plan = ok(planRespend(requestTo(bob, 1_000_000n), held, payCtx(me)))
    expect(plan.spend.lockSeq).not.toBe(NO_LOCK)
    expect(plan.spend.lockSeq).toBe(plan.lock.lockSeq)
  })

  it('refuses when my bond does not cover four times the amount', () => {
    const held = [heldNote({ from: issuer, to: me, amount: 1_000_000n })]
    const r = planRespend(requestTo(bob, 1_000_000n), held, payCtx(me, { bond: 3_999_999n }))
    expect(r).toEqual({ ok: false, reason: 'BondTooSmall' })
  })

  it('counts the bond against the whole input, the amount the receiver checks it for', () => {
    const held = [heldNote({ from: issuer, to: me, amount: 5_000_000n })]
    const r = planRespend(requestTo(bob, 1_000_000n), held, payCtx(me, { bond: 10_000_000n }))
    expect(r).toEqual({ ok: false, reason: 'BondTooSmall' })
  })

  it('refuses when no held note has a hop left for what the receiver asks', () => {
    const held = [heldNote({ from: issuer, to: me, amount: 1_000_000n, hopsLeft: 2 })]
    const r = planRespend(requestTo(bob, 1_000_000n, { minHops: 2 }), held, payCtx(me))
    expect(r).toEqual({ ok: false, reason: 'NoPassableNote' })
  })

  it('does not offer change on a note with a single hop left', () => {
    const held = [heldNote({ from: issuer, to: me, amount: 2_000_000n, hopsLeft: 1 })]
    expect(planRespend(requestTo(bob, 1_000_000n), held, payCtx(me)).ok).toBe(false)
  })

  it('steps the expiry down and keeps the receiver window', () => {
    const expiry = NOW + 10 * 3600
    const held = [heldNote({ from: issuer, to: me, amount: 1_000_000n, expiry })]
    const plan = ok(planRespend(requestTo(bob, 1_000_000n, { minWindow: 3600 }), held, payCtx(me)))
    const outputs = plan.spend.outputs
    const child = outputs.type === 'one' ? outputs.caveats : outputs.caveats0
    expect(child.expiry).toBeLessThanOrEqual(expiry - EXPIRY_STEP)
    expect(child.expiry).toBeGreaterThanOrEqual(NOW + 3600)
  })

  it('refuses a note too close to expiry to leave the receiver its window', () => {
    const held = [heldNote({ from: issuer, to: me, amount: 1_000_000n, expiry: NOW + EXPIRY_STEP + 60 })]
    const r = planRespend(requestTo(bob, 1_000_000n, { minWindow: 3600 }), held, payCtx(me))
    expect(r.ok).toBe(false)
  })

  it('picks the smallest sufficient note, then the one expiring first', () => {
    const big = heldNote({ from: issuer, to: me, amount: 9_000_000n })
    const soon = heldNote({ from: issuer, to: me, amount: 3_000_000n, expiry: NOW + 5 * 3600 })
    const late = heldNote({ from: issuer, to: me, amount: 3_000_000n, expiry: NOW + 9 * 3600 })
    const plan = ok(planRespend(requestTo(bob, 2_000_000n), [big, late, soon], payCtx(me)))
    expect(plan.input).toBe(soon)
  })

  it('does not pass on an authority-only note', () => {
    const held = [heldNote({ from: issuer, to: me, amount: 1_000_000n, flags: Flags.AuthorityOnly })]
    expect(planRespend(requestTo(bob, 1_000_000n), held, payCtx(me)).ok).toBe(false)
  })

  it('does not pass on a note it does not own', () => {
    const held = [heldNote({ from: issuer, to: bob, amount: 1_000_000n })]
    expect(planRespend(requestTo(bob, 1_000_000n), held, payCtx(me))).toEqual({ ok: false, reason: 'NoPassableNote' })
  })

  it('refuses to pay itself', () => {
    const held = [heldNote({ from: issuer, to: me, amount: 1_000_000n })]
    expect(planRespend(requestTo(me, 1_000_000n), held, payCtx(me))).toEqual({ ok: false, reason: 'SelfPayment' })
  })

  it('refuses a lock that ends before the note can be challenged', () => {
    const expiry = NOW + 5 * 86_400
    const held = [heldNote({ from: issuer, to: me, amount: 1_000_000n, expiry })]
    const ends = (lockUntil: number) => planRespend(requestTo(bob, 1_000_000n), held, payCtx(me, { lockUntil }))
    expect(ends(expiry + GRACE + CHALLENGE)).toEqual({ ok: false, reason: 'LockTooShort' })
    expect(ends(expiry + GRACE + CHALLENGE + 1).ok).toBe(true)
  })

  it('refuses when my own ticket would be stale when the receiver checks it', () => {
    const held = [heldNote({ from: issuer, to: me, amount: 1_000_000n })]
    const r = planRespend(requestTo(bob, 1_000_000n), held, payCtx(me, { ticketValidUntil: NOW + 60 }))
    expect(r).toEqual({ ok: false, reason: 'TicketStale' })
  })

  it('does not pass on a delegated note', () => {
    const held = [heldNote({ from: issuer, to: me, amount: 1_000_000n, flags: Flags.Delegated })]
    expect(planRespend(requestTo(bob, 1_000_000n), held, payCtx(me)).ok).toBe(false)
  })

  it('refuses when an earlier spender ticket is stale at the receiver', () => {
    const held = [heldNote({ from: issuer, to: me, amount: 1_000_000n })]
    const later = NOW + 4 * 86_400
    const r = planRespend(requestTo(bob, 1_000_000n, { now: later }), held, payCtx(me, { now: later }))
    expect(r).toEqual({ ok: false, reason: 'TicketStale' })
  })

  it('produces a bundle the next receiver accepts, with one ticket per lock', () => {
    const held = [heldNote({ from: issuer, to: me, amount: 5_000_000n })]
    const plan = ok(planRespend(requestTo(bob, 2_000_000n), held, payCtx(me)))
    const bundle = respendBundle(plan, signSpendWith(me, plan.input.output, plan.spend))
    const received = verifyPayment(receiverFor(bob), bundle.issue, bundle.spends, bundle.tickets)
    expect(received.output.amount).toBe(2_000_000n)
    expect(received.liable).toHaveLength(2)
    expect(new Set(bundle.tickets.map((t) => `${t.lockSeq}:${t.device}`)).size).toBe(bundle.tickets.length)
  })

  it('chains three re-spends and every receiver accepts', () => {
    const carol = party(4)
    const dan = party(5)
    let held = heldNote({ from: issuer, to: me, amount: 8_000_000n, hopsLeft: 4 })
    for (const [from, to] of [
      [me, bob],
      [bob, carol],
      [carol, dan],
    ] as const) {
      const plan = ok(planRespend(requestTo(to, held.output.amount / 2n), [held], payCtx(from)))
      const bundle = respendBundle(plan, signSpendWith(from, plan.input.output, plan.spend))
      const r = verifyPayment(receiverFor(to), bundle.issue, bundle.spends, bundle.tickets)
      held = { outputId: r.output.id, output: r.output, bundle }
    }
    expect(held.bundle.spends).toHaveLength(3)
  })
})

describe('bundle size', () => {
  it('matches the arithmetic of the wire constants: 388 bytes for an issue and its ticket, 380 for each hop', () => {
    const parties = [issuer, me, bob, party(4), party(5)]
    let held = heldNote({ from: parties[0], to: parties[1], amount: 16_000_000n, hopsLeft: 6 })
    const sizes: number[] = [encodeBundle(held.bundle).length]
    for (let i = 1; i < 4; i++) {
      const [from, to] = [parties[i], parties[i + 1]]
      const plan = ok(planRespend(requestTo(to, held.output.amount / 2n), [held], payCtx(from)))
      const bundle = respendBundle(plan, signSpendWith(from, plan.input.output, plan.spend))
      const r = verifyPayment(receiverFor(to), bundle.issue, bundle.spends, bundle.tickets)
      held = { outputId: r.output.id, output: r.output, bundle }
      sizes.push(encodeBundle(bundle).length)
    }
    expect(sizes.map((n) => n - 3)).toEqual([388, 768, 1148, 1528])
  })
})
