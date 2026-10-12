import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { RemainderStatus } from './remainder'
import { loadRemainderRows, remainderTabsOf } from './remainder-rows'
import { remainderWorld } from './testing/remainder-world'

const U = 1_000_000n
type World = Awaited<ReturnType<typeof remainderWorld>>
const keys = (w: World) => ({ d: w.c.tab.peerKey, c: w.d.tab.peerKey })

describe('what is left to pay when a session ends', () => {
  it('nothing_to_net_leaves_the_whole_balance_of_every_tab_with_a_known_peer', async () => {
    const w = await remainderWorld()
    const k = keys(w)
    const debtor = await remainderTabsOf(w.d.db, {
      session: w.session,
      deviceKey: k.d,
      mint: w.mint,
      outcome: { status: 'nothing', peers: [{ index: 2, key: k.c }] },
    })
    expect(debtor).toMatchObject([{ peer: 2, role: 'debtor', remaining: 5n * U }])
    expect(bytesToHex(debtor[0].peerKey)).toBe(bytesToHex(k.c))
    const creditor = await remainderTabsOf(w.c.db, {
      session: w.session,
      deviceKey: k.c,
      mint: w.mint,
      outcome: { status: 'nothing', peers: [{ index: 1, key: k.d }] },
    })
    expect(creditor).toMatchObject([{ peer: 1, role: 'creditor', remaining: 5n * U }])
  })

  it('a_tab_with_someone_who_is_not_in_the_session_is_not_offered', async () => {
    const w = await remainderWorld()
    const k = keys(w)
    expect(
      await remainderTabsOf(w.d.db, {
        session: w.session,
        deviceKey: k.d,
        mint: w.mint,
        outcome: { status: 'nothing', peers: [] },
      }),
    ).toEqual([])
  })

  it('an_agreed_netting_leaves_what_the_consent_view_said_remains', async () => {
    const w = await remainderWorld()
    const k = keys(w)
    const view = {
      tabs: [
        {
          tab: w.d.tab.tab,
          peerIndex: 2,
          direction: 'iOwe' as const,
          amount: 8n * U,
          cancel: 3n * U,
          remaining: 5n * U,
          due: 0,
        },
      ],
      netBefore: 0n,
      netAfter: 0n,
      participants: 2,
      total: 3n * U,
      expires: 1,
    }
    const tabs = await remainderTabsOf(w.d.db, {
      session: w.session,
      deviceKey: k.d,
      mint: w.mint,
      outcome: { status: 'agreed', proof: 'valid', view },
    })
    expect(tabs).toMatchObject([{ peer: 2, role: 'debtor', remaining: 5n * U }])
  })

  it('the_rows_follow_the_remainder_status_of_each_tab', async () => {
    const w = await remainderWorld()
    expect(await loadRemainderRows(w.d.db, w.session, w.d.tabs)).toMatchObject([
      { role: 'debtor', amount: 5n * U, state: 'due' },
    ])
    await w.d.db.run('UPDATE netting_remainder SET status = ?', [RemainderStatus.Repaid])
    expect((await loadRemainderRows(w.d.db, w.session, w.d.tabs))[0].state).toBe('sending')
    await w.d.db.run('UPDATE netting_remainder SET status = ?', [RemainderStatus.Released])
    expect((await loadRemainderRows(w.d.db, w.session, w.d.tabs))[0].state).toBe('released')
    await w.d.db.run('UPDATE netting_remainder SET status = ?', [RemainderStatus.Skipped])
    expect(await loadRemainderRows(w.d.db, w.session, w.d.tabs)).toEqual([])
  })
})
