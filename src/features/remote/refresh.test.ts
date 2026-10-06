import { describe, expect, it } from 'vitest'
import { GRACE } from '../../protocol'
import { MARGIN } from './delivery'
import { refreshDeliveries } from './refresh'
import { sendRemote } from './send'
import { fakeChainRpc, PROGRAM_FOR_TESTS, remoteWorld } from './testing'

const queued = async () => {
  const w = remoteWorld({ online: false })
  const signed = await w.signed(2_000_000n)
  await sendRemote(w.ctx, signed)
  return { w, expiry: signed.issue.message.caveats.expiry }
}

describe('reading delivery from the chain', () => {
  it('moves a payment whose record holds its content to delivered and pays out the reservation', async () => {
    const { w } = await queued()
    const [row] = await w.db.all<{ content: Uint8Array }>('SELECT content FROM relay_outbox')
    const rpc = fakeChainRpc({ record: { content: row.content, flags: 1 }, slotBlockTime: 1 })
    expect(await refreshDeliveries(w.db, rpc, PROGRAM_FOR_TESTS, w.ctx.now())).toBe(1)
    expect(await w.state()).toBe('delivered')
    expect(await w.reserved()).toBe(0n)
  })
  it('expires it only when the cluster time is past the window and keeps it before', async () => {
    const { w, expiry } = await queued()
    await refreshDeliveries(
      w.db,
      fakeChainRpc({ record: null, slotBlockTime: expiry + GRACE + MARGIN }),
      PROGRAM_FOR_TESTS,
      1,
    )
    expect(await w.state()).toBe('signed')
    await refreshDeliveries(
      w.db,
      fakeChainRpc({ record: null, slotBlockTime: expiry + GRACE + MARGIN + 1 }),
      PROGRAM_FOR_TESTS,
      1,
    )
    expect(await w.state()).toBe('expired')
    expect(await w.reserved()).toBe(0n)
  })
  it('does not read payments that already ended', async () => {
    const { w } = await queued()
    await w.answer({ status: 'settled', signature: 's' })
    const rpc = fakeChainRpc({ record: null, slotBlockTime: 9_000_000_000 })
    expect(await refreshDeliveries(w.db, rpc, PROGRAM_FOR_TESTS, 1)).toBe(0)
    expect(rpc.commitments()).toEqual([])
  })
})
