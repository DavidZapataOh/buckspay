import { describe, expect, it } from 'vitest'
import { encodeIssue, encodeSpend } from '../../protocol'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { toHand } from '../relay/carry'
import { runHandoffs } from '../relay/run'
import { relayerLink, seen } from '../relay/testing'
import { sendRemote } from './send'
import { remoteWorld } from './testing'

describe('sending a remote payment', () => {
  it('online: settles directly and never seals', async () => {
    const w = remoteWorld({ online: true })
    await sendRemote(w.ctx, await w.signed(2_000_000n))
    expect(w.settleDirect).toHaveBeenCalledOnce()
    expect(await w.outboxRows()).toHaveLength(0)
    expect(await w.reserved()).toBe(0n)
  })
  it('online but no answer: falls back to the outbox, the money stays reserved', async () => {
    const w = remoteWorld({ online: true, outcome: { kind: 'unknown' } })
    await sendRemote(w.ctx, await w.signed(2_000_000n))
    expect(await w.outboxRows()).toHaveLength(1)
    expect(await w.reserved()).toBe(2_000_000n)
  })
  it('offline: one outbox row with eight copies, the amount reserved, nothing posted', async () => {
    const w = remoteWorld({ online: false })
    await sendRemote(w.ctx, await w.signed(2_000_000n))
    expect(await w.outboxRows()).toMatchObject([{ kind: 'remote', copies_left: 8 }])
    expect(await w.reserved()).toBe(2_000_000n)
    expect(w.settleDirect).not.toHaveBeenCalled()
  })
  it('a retry answer keeps the reservation and the state', async () => {
    const w = remoteWorld({ online: false })
    await sendRemote(w.ctx, await w.signed(2_000_000n))
    await w.answer({ status: 'retry', retryAfter: 600 })
    expect(await w.reserved()).toBe(2_000_000n)
    expect(await w.state()).toBe('received')
    await w.answer({ status: 'duplicate' })
    expect(await w.reserved()).toBe(2_000_000n)
    expect(await w.state()).toBe('relaying')
  })
  it('only a final refused answer releases the reservation', async () => {
    const w = remoteWorld({ online: false })
    await sendRemote(w.ctx, await w.signed(2_000_000n))
    await w.answer({ status: 'refused', reason: 'window' })
    expect(await w.state()).toBe('refused')
    expect(await w.reserved()).toBe(0n)
  })
  it('a conflict keeps the reservation, and a settled answer pays it out', async () => {
    const w = remoteWorld({ online: false })
    await sendRemote(w.ctx, await w.signed(2_000_000n))
    await w.answer({ status: 'refused', reason: 'conflict' })
    expect(await w.reserved()).toBe(2_000_000n)
    const paid = remoteWorld({ online: false })
    await sendRemote(paid.ctx, await paid.signed(2_000_000n))
    await paid.answer({ status: 'settled', signature: 's' })
    expect(await paid.state()).toBe('delivered')
    expect(await paid.reserved()).toBe(0n)
  })
  it('an expired read releases the reservation', async () => {
    const w = remoteWorld({ online: false })
    await sendRemote(w.ctx, await w.signed(2_000_000n))
    await w.chain({ record: 'none', commitment: 'finalized', blockTime: 9_000_000_000 })
    expect(await w.state()).toBe('expired')
    expect(await w.reserved()).toBe(0n)
  })
  it('the sealed inner carries exactly the signed chain the user confirmed', async () => {
    const w = remoteWorld({ online: false })
    const signed = await w.signed(2_000_000n)
    await sendRemote(w.ctx, signed)
    expect(await w.openOutboxAsGateway()).toEqual({
      issue: encodeIssue(signed.issue),
      spends: signed.spends.map(encodeSpend),
    })
  })
  it('sprays half the copies to a carrier in range and says it was passed on', async () => {
    const w = remoteWorld({ online: false })
    await sendRemote(w.ctx, await w.signed(2_000_000n))
    const carrier = createNodeDb()
    await migrate(carrier)
    const beacon = seen({ rssi: -40, online: false })
    const link = relayerLink(
      carrier,
      async () => new Uint8Array(0),
      () => 5,
      false,
    )
    await runHandoffs({ db: w.db, link, clusterTag: beacon.value.clusterTag, beacons: [beacon], now: w.ctx.now() })
    expect(await w.outboxRows()).toMatchObject([{ copies_left: 4 }])
    expect(await w.state()).toBe('received')
    expect((await toHand(carrier, { online: false }, 6))[0].copies).toBe(2)
    expect(await w.reserved()).toBe(2_000_000n)
  })
  it('online: a refusal that a retry can change queues the payment, a final one does not', async () => {
    const wait = remoteWorld({
      online: true,
      outcome: { kind: 'refused', refusal: { kind: 'no_token_account' }, selfPay: false },
    })
    expect(await sendRemote(wait.ctx, await wait.signed(2_000_000n))).toBe('queued')
    expect(await wait.reserved()).toBe(2_000_000n)
    const late = remoteWorld({
      online: true,
      outcome: { kind: 'refused', refusal: { kind: 'window' }, selfPay: false },
    })
    expect(await sendRemote(late.ctx, await late.signed(2_000_000n))).toBe('refused')
    expect(await late.outboxRows()).toHaveLength(0)
    expect(await late.reserved()).toBe(0n)
  })
  it('marks the payer’s ledger by how it ended: confirmed, abandoned, and still signed over a conflict', async () => {
    const ledger = (w: ReturnType<typeof remoteWorld>) =>
      w.db.all<{ state: string }>('SELECT state FROM outgoing_payment').then((rows) => rows[0].state)
    const paid = remoteWorld({ online: false })
    await sendRemote(paid.ctx, await paid.signed(1_000_000n))
    await paid.answer({ status: 'settled', signature: 's' })
    expect(await ledger(paid)).toBe('confirmed')
    const refused = remoteWorld({ online: false })
    await sendRemote(refused.ctx, await refused.signed(1_000_000n))
    await refused.answer({ status: 'refused', reason: 'lock' })
    expect(await ledger(refused)).toBe('abandoned')
    const conflict = remoteWorld({ online: false })
    await sendRemote(conflict.ctx, await conflict.signed(1_000_000n))
    await conflict.answer({ status: 'refused', reason: 'conflict' })
    expect(await ledger(conflict)).toBe('signed')
  })
})
