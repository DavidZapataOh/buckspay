import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'
import { IouCause } from '../../protocol'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { seedHeld } from '../notes/testing/seed'
import {
  appliedNettings,
  coSignedStates,
  DEBTS_SCHEMA_VERSION,
  latestFinal,
  listTabs,
  lockTabs,
  migrateDebts,
  openTab,
  pendingProposal,
  repayStatuses,
  reserveSeq,
  saveCoSigned,
  saveProposal,
  saveRepayNote,
  setRepayStatus,
  statesOf,
  tabNow,
  tabSecret,
  tabWith,
  takeNextSeq,
  unlockTabs,
} from './store'
import { intentChange } from './tab'
import { coSigned, iouOf, MINT, party, SECRET, TAB } from './testing'

const NOW = 1_800_000_000
const [ana, ben, cai] = [party(0xa1), party(0xb1), party(0xc1)]
const SESSION = new Uint8Array(32).fill(0x5e)
const M = new Uint8Array(32).fill(0x9e)
const CONTENT = sha256(Uint8Array.of(1, 0x32))
const tabFill = (n: number) => new Uint8Array(32).fill(n)

async function fresh() {
  const db = createNodeDb()
  await migrate(db)
  return db
}

const open = (db: Awaited<ReturnType<typeof fresh>>, peer = ben.key, tab = TAB, mint = MINT) =>
  openTab(db, { tab, secret: SECRET, peer, mint }, NOW)

describe('migration 12', () => {
  it('migrates_11_to_12_keeping_rows', async () => {
    const db = createNodeDb()
    await migrate(db)
    await seedHeld(db, { outputId: new Uint8Array(32).fill(1), owner: ana.key })
    await db.exec(
      'DROP TABLE netting_remainder; DROP TABLE repay_notes; DROP TABLE netting_effects; DROP TABLE netting_bases; DROP TABLE netting_sessions; DROP TABLE tab_states; DROP TABLE tabs; PRAGMA user_version = 11;',
    )
    await migrateDebts(db)
    const [{ user_version }] = await db.all<{ user_version: number }>('PRAGMA user_version')
    expect(DEBTS_SCHEMA_VERSION).toBe(12)
    expect(user_version).toBe(12)
    expect(await db.all('SELECT output_id FROM received_note')).toHaveLength(1)
    const tables = (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map(
      (t) => t.name,
    )
    expect(tables).toEqual(
      expect.arrayContaining([
        'tabs',
        'tab_states',
        'netting_sessions',
        'netting_bases',
        'netting_effects',
        'repay_notes',
        'netting_remainder',
        'leaf_secrets',
      ]),
    )
    const columns = async (table: string) =>
      (await db.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((c) => c.name)
    expect(await columns('netting_bases')).toEqual(['tab', 'base_seq', 'session', 'content'])
    expect(await columns('netting_effects')).toEqual(['session', 'tab', 'base_seq', 'debtor', 'cancel'])
    expect(await columns('repay_notes')).toEqual([
      'tab',
      'seq',
      'reference',
      'payee',
      'reduction',
      'request',
      'status',
      'checked_at',
    ])
    const pk = (await db.all<{ name: string; pk: number }>('PRAGMA table_info(netting_bases)'))
      .filter((c) => c.pk > 0)
      .map((c) => c.name)
    expect(pk).toEqual(['tab', 'base_seq', 'session'])
  })

  it('refuses_store_not_at_11', async () => {
    const db = createNodeDb()
    await db.exec('PRAGMA user_version = 10')
    await expect(migrateDebts(db)).rejects.toThrow('The note store must be at version 11 before the debts migration')
    await expect(migrateDebts(await fresh())).resolves.toBeUndefined()
  })

  it('13 is the newest version this app opens', async () => {
    const db = createNodeDb()
    await db.exec('PRAGMA user_version = 14')
    await expect(migrate(db)).rejects.toThrow('The note store is version 14, newer than this app.')
    await expect(migrate(await fresh())).resolves.toBeUndefined()
  })
})

describe('tabs', () => {
  it('one_open_tab_per_peer_and_mint', async () => {
    const db = await fresh()
    await open(db)
    await expect(open(db, ben.key, tabFill(0x7b))).rejects.toMatchObject({ reason: 'other-tab' })
    await expect(open(db, cai.key, TAB)).rejects.toMatchObject({ reason: 'other-tab' })
    await open(db, ben.key, tabFill(0x7c), new Uint8Array(32).fill(4))
    await open(db, cai.key, tabFill(0x7d))
    expect((await tabWith(db, ben.key, MINT))?.tab).toEqual(TAB)
    expect(await tabSecret(db, TAB)).toEqual(SECRET)
    expect(await listTabs(db)).toHaveLength(3)
  })

  it('takeNextSeq_survives_restart_before_sign', async () => {
    const db = await fresh()
    await open(db)
    expect(await takeNextSeq(db, TAB)).toBe(1)
    // the app dies here, before signing: seq 1 is burnt and never handed out again
    expect(await takeNextSeq(db, TAB)).toBe(2)
    const [row] = await db.all<{ next_seq: number }>('SELECT next_seq FROM tabs WHERE tab = ?', [TAB])
    expect(row.next_seq).toBe(3)
  })

  it('reserveSeq_never_lowers', async () => {
    const db = await fresh()
    await open(db)
    await reserveSeq(db, TAB, 7)
    expect(await tabWith(db, ben.key, MINT)).toMatchObject({ nextSeq: 8 })
    await reserveSeq(db, TAB, 2)
    await reserveSeq(db, TAB, 7)
    expect(await tabWith(db, ben.key, MINT)).toMatchObject({ nextSeq: 8 })
    expect(await takeNextSeq(db, TAB)).toBe(8)
    await reserveSeq(db, TAB, 20)
    expect(await takeNextSeq(db, TAB)).toBe(21)
  })

  it('a failed write hands out no seq', async () => {
    const db = createNodeDb((sql) => /^\s*UPDATE\s+tabs\s+SET\s+next_seq/i.test(sql))
    await migrate(db)
    await open(db)
    await expect(takeNextSeq(db, TAB)).rejects.toThrow('injected failure')
    const [row] = await db.all<{ next_seq: number }>('SELECT next_seq FROM tabs WHERE tab = ?', [TAB])
    expect(row.next_seq).toBe(1)
  })

  it('replayed_iou_never_lowers_final_seq', async () => {
    const db = await fresh()
    await open(db)
    await saveCoSigned(db, coSigned(iouOf(5, ana.key, ben.key, 10n), ana, ben), NOW)
    await saveCoSigned(db, coSigned(iouOf(3, ana.key, ben.key, 30n), ana, ben), NOW + 1)
    const final = await latestFinal(db, TAB)
    expect(final?.iou.seq).toBe(5)
    expect(final?.iou.amount).toBe(10n)
    expect(await tabWith(db, ben.key, MINT)).toMatchObject({ finalSeq: 5, nextSeq: 6 })
    expect((await statesOf(db, TAB)).map((s) => s.iou.seq)).toEqual([5, 3])
  })

  it('final_and_next_seq_jump_over_gaps', async () => {
    const db = await fresh()
    await open(db)
    await saveCoSigned(db, coSigned(iouOf(1, ana.key, ben.key, 10n), ana, ben), NOW)
    await saveCoSigned(db, coSigned(iouOf(9, ben.key, ana.key, 4n), ben, ana), NOW)
    expect(await tabWith(db, ben.key, MINT)).toMatchObject({ finalSeq: 9, nextSeq: 10 })
    expect(await takeNextSeq(db, TAB)).toBe(10)
  })

  it('a proposal is pending until co-signed or overtaken', async () => {
    const db = await fresh()
    await open(db)
    expect([await takeNextSeq(db, TAB), await takeNextSeq(db, TAB)]).toEqual([1, 2])
    const s2 = coSigned(iouOf(2, ana.key, ben.key, 10n), ana, ben)
    await saveProposal(db, { iou: s2.iou, signature: s2.debtorSig, memo: 'Taxi' }, NOW)
    const pending = await pendingProposal(db, TAB)
    expect(pending).toMatchObject({ memo: 'Taxi', creditorSig: null })
    expect(pending?.iou.seq).toBe(2)
    expect(pending?.debtorSig).toEqual(s2.debtorSig)
    expect(await latestFinal(db, TAB)).toBeNull()
    expect(await takeNextSeq(db, TAB)).toBe(3)
    expect(await pendingProposal(db, TAB)).toBeNull()
    expect(await takeNextSeq(db, TAB)).toBe(4)
    const s4 = coSigned(iouOf(4, ana.key, ben.key, 12n), ana, ben)
    await saveProposal(db, { iou: s4.iou, signature: s4.debtorSig, memo: null }, NOW)
    expect((await pendingProposal(db, TAB))?.iou.seq).toBe(4)
    await saveCoSigned(db, s4, NOW)
    expect(await pendingProposal(db, TAB)).toBeNull()
    expect((await latestFinal(db, TAB))?.iou.seq).toBe(4)
    expect((await statesOf(db, TAB)).map((s) => s.iou.seq)).toEqual([4, 2])
  })

  it('locked_tab_refuses_change', async () => {
    const db = await fresh()
    await open(db)
    await open(db, cai.key, tabFill(0x7d))
    await lockTabs(db, SESSION, [TAB])
    await expect(takeNextSeq(db, TAB)).rejects.toMatchObject({ reason: 'locked' })
    await expect(reserveSeq(db, TAB, 3)).rejects.toMatchObject({ reason: 'locked' })
    await expect(lockTabs(db, tabFill(0x5f), [tabFill(0x7d), TAB])).rejects.toMatchObject({ reason: 'locked' })
    expect((await tabWith(db, cai.key, MINT))?.lockedBy).toBeNull()
    await unlockTabs(db, tabFill(0x5f))
    await expect(takeNextSeq(db, TAB)).rejects.toMatchObject({ reason: 'locked' })
    await unlockTabs(db, SESSION)
    expect(await takeNextSeq(db, TAB)).toBe(1)
  })

  it('repay_notes_and_recorded_nettings_feed_the_balance', async () => {
    const db = await fresh()
    await open(db)
    const s1 = coSigned(iouOf(1, ben.key, ana.key, 10n), ben, ana)
    const r2 = coSigned(iouOf(2, ben.key, ana.key, 4n, { cause: IouCause.Repay, reference: M }), ben, ana)
    await saveCoSigned(db, s1, NOW)
    await saveCoSigned(db, r2, NOW)
    const note = { tab: TAB, seq: 2, reference: M, payee: ana.key, reduction: 4n, request: Uint8Array.of(1) }
    await saveRepayNote(db, note)
    await saveRepayNote(db, { ...note, reduction: 99n })
    expect(await repayStatuses(db, TAB)).toEqual([
      { tab: TAB, seq: 2, reference: M, payee: ana.key, reduction: 4n, status: 'settling' },
    ])
    expect(await coSignedStates(db, TAB)).toEqual([s1, r2])
    expect(await tabNow(db, ana.key, TAB)).toEqual({ balance: 10n, pending: true })
    await setRepayStatus(db, TAB, M, 'settled', NOW)
    expect(await tabNow(db, ana.key, TAB)).toEqual({ balance: 6n, pending: false })
    await db.run(
      'INSERT INTO netting_sessions (session, role, my_index, status, created_at, updated_at) VALUES (?, 1, 1, 3, ?, ?)',
      [SESSION, NOW, NOW],
    )
    await db.run('INSERT INTO netting_bases (tab, base_seq, session, content) VALUES (?, 2, ?, ?)', [
      TAB,
      SESSION,
      CONTENT,
    ])
    await db.run('INSERT INTO netting_effects (session, tab, base_seq, debtor, cancel) VALUES (?, ?, 2, ?, 5)', [
      SESSION,
      TAB,
      ben.key,
    ])
    expect(await appliedNettings(db, TAB)).toEqual([])
    expect(await tabNow(db, ana.key, TAB)).toEqual({ balance: 6n, pending: true })
    await db.run('UPDATE netting_sessions SET status = 7')
    expect(await tabNow(db, ana.key, TAB)).toEqual({ balance: 6n, pending: true })
    await db.run('UPDATE netting_sessions SET status = 4')
    expect(await appliedNettings(db, TAB)).toEqual([
      { content: CONTENT, tab: TAB, baseSeq: 2, debtor: ben.key, cancel: 5n },
    ])
    expect(await tabNow(db, ana.key, TAB)).toEqual({ balance: 1n, pending: false })
    expect(await tabNow(db, ben.key, TAB)).toEqual({ balance: -1n, pending: false })
    for (const status of [5, 6]) {
      await db.run('UPDATE netting_sessions SET status = ?', [status])
      expect(await appliedNettings(db, TAB), `status ${status}`).toEqual([])
    }
  })

  it('setRepayStatus_maps_every_outcome', async () => {
    const db = await fresh()
    await open(db)
    await saveCoSigned(db, coSigned(iouOf(1, ben.key, ana.key, 10n), ben, ana), NOW)
    await saveCoSigned(
      db,
      coSigned(iouOf(2, ben.key, ana.key, 4n, { cause: IouCause.Repay, reference: M }), ben, ana),
      NOW,
    )
    await saveRepayNote(db, { tab: TAB, seq: 2, reference: M, payee: ana.key, reduction: 4n, request: null })
    const cases: [Parameters<typeof setRepayStatus>[3], number, bigint, boolean][] = [
      ['void', 3, 10n, false],
      ['unknown', 4, 10n, true],
      ['undecided', 5, 10n, true],
      ['settled', 1, 6n, false],
    ]
    for (const [status, code, expected, pending] of cases) {
      await setRepayStatus(db, TAB, M, status, NOW + code)
      const [row] = await db.all<{ status: number; checked_at: number }>('SELECT status, checked_at FROM repay_notes')
      expect(row, status).toEqual({ status: code, checked_at: NOW + code })
      expect((await repayStatuses(db, TAB))[0], status).toMatchObject({ status })
      expect(await tabNow(db, ana.key, TAB), status).toEqual({ balance: expected, pending })
    }
  })

  it('clear_refused_while_a_repay_is_unknown_or_void_not_final', async () => {
    const db = await fresh()
    await open(db)
    await saveCoSigned(db, coSigned(iouOf(1, ben.key, ana.key, 10n), ben, ana), NOW)
    await saveCoSigned(
      db,
      coSigned(iouOf(2, ben.key, ana.key, 4n, { cause: IouCause.Repay, reference: M }), ben, ana),
      NOW,
    )
    await saveRepayNote(db, { tab: TAB, seq: 2, reference: M, payee: ana.key, reduction: 4n, request: null })
    const clear = async () =>
      intentChange(ana.key, ben.key, { kind: 'clear', amount: 0n, due: 0, memo: null }, await tabNow(db, ana.key, TAB))
    // a first void read is not final: the row stays settling with checked_at set, and the tab stays pending
    await db.run('UPDATE repay_notes SET checked_at = ?', [NOW])
    await expect(clear()).rejects.toMatchObject({ reason: 'pending' })
    for (const status of ['unknown', 'undecided'] as const) {
      await setRepayStatus(db, TAB, M, status, NOW)
      await expect(clear(), status).rejects.toMatchObject({ reason: 'pending' })
    }
    await setRepayStatus(db, TAB, M, 'void', NOW)
    await expect(clear()).resolves.toMatchObject({ debtor: ben.key, creditor: ana.key, amount: 10n })
  })

  it('save_cosigned_refuses_another_body_at_a_seq', async () => {
    const db = await fresh()
    await open(db)
    const first = coSigned(iouOf(2, ben.key, ana.key, 4n), ben, ana)
    await saveCoSigned(db, first, NOW)
    await saveCoSigned(db, first, NOW + 1)
    const other = coSigned(iouOf(2, ben.key, ana.key, 9n), ben, ana)
    await expect(saveCoSigned(db, other, NOW)).rejects.toMatchObject({ reason: 'malformed' })
    expect(await coSignedStates(db, TAB)).toEqual([first])
    const proposal = coSigned(iouOf(3, ana.key, ben.key, 1n), ana, ben)
    await saveProposal(db, { iou: proposal.iou, signature: proposal.debtorSig, memo: null }, NOW)
    await expect(saveCoSigned(db, coSigned(iouOf(3, ana.key, ben.key, 2n), ana, ben), NOW)).rejects.toMatchObject({
      reason: 'malformed',
    })
    await saveCoSigned(db, proposal, NOW)
    expect((await coSignedStates(db, TAB)).map((x) => x.iou.seq)).toEqual([2, 3])
  })
})
