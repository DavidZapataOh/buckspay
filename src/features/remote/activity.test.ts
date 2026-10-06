import { describe, expect, it } from 'vitest'
import { GRACE } from '../../protocol'
import { sentence } from '../activity/format'
import { activityDetail, listActivity } from '../notes/activity'
import { unfinishedPayments } from '../notes/outgoing'
import { saveContact } from './contacts'
import { sendRemote } from './send'
import { link, remoteWorld } from './testing'

describe('a remote payment in the activity', () => {
  it('shows its own state, the contact it went to and the honest word for it', async () => {
    const w = remoteWorld({ online: false })
    const signed = await w.signed(2_000_000n)
    await sendRemote(w.ctx, signed)
    await saveContact(w.db, link, 1, null)
    const [row] = await listActivity(w.db, 10)
    expect(row).toMatchObject({ kind: 'paid', state: 'remote-signed', remote: true, payee: 'Ana' })
    expect(sentence(row, 'USDC', 6)).toBe('Paid 2.00 USDC · Ana · Waiting for a phone nearby')
    await w.answer({ status: 'duplicate' })
    expect(sentence((await listActivity(w.db, 10))[0], 'USDC', 6)).toBe('Paid 2.00 USDC · Ana · On its way')
  })
  it('says not delivered, money kept, once it expired', async () => {
    const w = remoteWorld({ online: false })
    await sendRemote(w.ctx, await w.signed(2_000_000n))
    await w.chain({ record: 'none', commitment: 'finalized', blockTime: 9_000_000_000 })
    expect(sentence((await listActivity(w.db, 10))[0], 'USDC', 6)).toContain('Not delivered, money kept')
  })
  it('is never offered to be resumed or discarded, and its detail carries the deadline', async () => {
    const w = remoteWorld({ online: false })
    const signed = await w.signed(2_000_000n)
    await sendRemote(w.ctx, signed)
    expect(await unfinishedPayments(w.db)).toEqual([])
    const detail = await activityDetail(w.db, 'paid', signed.messageId)
    expect(detail).toMatchObject({
      unfinished: false,
      remote: true,
      deadline: signed.issue.message.caveats.expiry + GRACE,
    })
  })
})
