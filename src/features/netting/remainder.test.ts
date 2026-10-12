import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it, vi } from 'vitest'
import {
  decodeIou,
  decodeIssue,
  interval,
  issueSlot,
  recordAddress,
  outputId,
  content,
  encodeIssueBody,
} from '../../protocol'
import { decodeDebtMessage } from '../debts/exchange'
import { MessageKind } from '../../transport/types'
import { receivePayment } from '../../payment/receive-flow'
import { PROGRAM } from '../../payment/testing/world'
import {
  checkRemainderRequest,
  collectChains,
  collectRemainder,
  noteState,
  type NoteStateDeps,
  payRemainder,
  proposeSimplification,
  receiveRemainder,
  type RemainderRefusal,
  RemainderStatus,
  resumeRelease,
  skipRemainder,
} from './remainder'
import { reconcileRepays } from './sweep'
import { remainderWorld } from './testing/remainder-world'

const U = 1_000_000n
type World = Awaited<ReturnType<typeof remainderWorld>>
const run = (w: World) => {
  const ctl = new AbortController()
  return Promise.all([payRemainder(w.d.deps, w.d.tab, ctl.signal), receiveRemainder(w.c.deps, w.c.tab, ctl.signal)])
}
const remainderRow = async (w: World, who: 'd' | 'c') =>
  (await w[who].db.all<{ status: number }>('SELECT status FROM netting_remainder'))[0]
const notes = (w: World, who: 'd' | 'c') =>
  w[who].db.all<{ status: number; reference: Uint8Array; request: Uint8Array | null; checked_at: number | null }>(
    'SELECT status, reference, request, checked_at FROM repay_notes',
  )
const bal = (w: World, who: 'd' | 'c') => w[who].balance()
const exp = (w: World, who: 'd' | 'c') => w[who].expectedBalance()

describe('Repay before release', () => {
  it('collectRemainder_creates_a_row_for_every_remaining_tab_and_none_for_cancelled_ones', async () => {
    const w = await remainderWorld({ remaining: [5n * U, 0n] })
    await collectRemainder(w.d.db, w.session, w.d.tabs)
    expect(await w.d.db.all('SELECT status FROM netting_remainder')).toEqual([{ status: RemainderStatus.Due }])
  })

  it('remainder_payment_over_relay_marks_paid_settling', async () => {
    const w = await remainderWorld()
    const [paid, received] = await run(w)
    expect([paid.status, received.status]).toEqual(['released', 'released'])
    expect((await remainderRow(w, 'd')).status).toBe(RemainderStatus.Released)
    expect((await notes(w, 'c'))[0].status).toBe(0)
    expect(await bal(w, 'c')).toBe(w.before)
    expect(await exp(w, 'c')).toBe(w.before - 5n * U)
    expect(bytesToHex((await notes(w, 'c'))[0].reference)).toBe(bytesToHex(paid.messageId!))
  })

  it('creditor_withholding_repay_after_receipt_cannot_happen', async () => {
    const w = await remainderWorld()
    w.net.dropKind(MessageKind.Debts, { fromIndex: 2 })
    const [paid] = await run(w)
    expect(paid.status).not.toBe('released')
    expect(w.net.payloadBytesSentBy(1, MessageKind.Payment)).toBe(0)
    expect(await w.c.db.all('SELECT * FROM received_note')).toHaveLength(0)
  })

  it('the_note_leaves_the_debtor_only_after_the_cosigned_repay_is_stored', async () => {
    const w = await remainderWorld()
    let storedFirst = false
    w.net.onFrame(MessageKind.Payment, async () => {
      storedFirst =
        (await notes(w, 'd')).length === 1 &&
        (await w.d.latestStates()).some((s) => s.iou.cause === 2 && s.creditorSig.length === 64)
    })
    await run(w)
    expect(w.net.sawFrame(MessageKind.Payment)).toBe(true)
    expect(storedFirst).toBe(true)
  })

  it('dropped_link_after_note_keeps_a_cosigned_conditional_repay', async () => {
    const w = await remainderWorld()
    w.net.dropKind(MessageKind.Payment)
    const [paid] = await run(w)
    expect(paid.status).toBe('repaid')
    expect((await notes(w, 'd'))[0].status).toBe(0)
    expect((await w.d.db.all("SELECT * FROM outgoing_payment WHERE state = 'signed'")).length).toBe(1)
    w.net.stopDropping()
    const listening = receivePayment(w.c.deps.receiveContext, w.c.link(w.d.index), { timeoutMs: 2000 })
    expect((await resumeRelease(w.d.deps, paid.messageId!, w.d.link(w.c.index))).status).toBe('released')
    await listening
    expect((await w.c.db.all('SELECT * FROM received_note')).length).toBe(1)
  })

  it('the_creditors_request_is_bound_to_the_tab_payee_amount_and_mint', async () => {
    const w = await remainderWorld()
    const good = w.c.deps.requestFor(w.c.tab)
    expect(() => checkRemainderRequest(good, w.d.tab, w.mint)).not.toThrow()
    const code = (r: typeof good) => {
      try {
        checkRemainderRequest(r, w.d.tab, w.mint)
      } catch (e) {
        return (e as RemainderRefusal).code
      }
    }
    expect(code({ ...good, owner: { type: 'device', key: w.host.key } })).toBe('WrongPayee')
    expect(code({ ...good, owner: { type: 'account', address: new Uint8Array(32).fill(1) } })).toBe('WrongPayee')
    expect(code({ ...good, amount: good.amount + 1n })).toBe('WrongAmount')
    expect(code({ ...good, amount: good.amount - 1n })).toBe('WrongAmount')
    expect(code({ ...good, mint: new Uint8Array(32).fill(8) })).toBe('WrongMint')
  })

  it('a_host_that_swaps_the_payee_in_the_request_makes_the_debtor_refuse_and_nothing_is_signed', async () => {
    const w = await remainderWorld()
    const swapped = { ...w.c.deps.requestFor(w.c.tab), owner: { type: 'device' as const, key: w.host.key } }
    const { encodeRequest } = await import('../../payment/messages')
    w.net.rewrite((relay) =>
      relay.kind === MessageKind.Request ? { ...relay, payload: encodeRequest(swapped) } : relay,
    )
    const [paid] = await run(w)
    expect(paid).toMatchObject({ status: 'failed', reason: 'WrongPayee' })
    expect(await w.d.db.all('SELECT * FROM outgoing_payment')).toHaveLength(0)
    expect((await remainderRow(w, 'd')).status).toBe(RemainderStatus.Due)
  })

  it('creditor_writes_repay_note_row_before_answering', async () => {
    const w = await remainderWorld()
    let rowsAtAccept = -1
    w.net.onFrame(MessageKind.Debts, async (relay) => {
      if (relay.from === 2 && decodeDebtMessage({ kind: relay.kind, payload: relay.payload }).type === 0x02) {
        rowsAtAccept = (await notes(w, 'c')).length
      }
    })
    await run(w)
    expect(rowsAtAccept).toBe(1)
  })

  it('a_repay_offer_for_another_amount_than_the_tab_has_left_is_declined_and_no_repay_is_stored', async () => {
    const w = await remainderWorld()
    const asked = w.c.deps.requestFor(w.c.tab)
    const creditor = { ...w.c.deps, requestFor: () => asked }
    const ctl = new AbortController()
    const [paid, received] = await Promise.all([
      payRemainder(w.d.deps, w.d.tab, ctl.signal),
      receiveRemainder(creditor, { ...w.c.tab, remaining: w.c.tab.remaining + 1n }, ctl.signal),
    ])
    expect([paid.status, received.status]).toEqual(['declined', 'declined'])
    expect(await notes(w, 'c')).toHaveLength(0)
  })

  it('a_repay_offer_naming_a_reference_the_tab_already_has_is_declined_and_counts_once', async () => {
    const w = await remainderWorld()
    w.net.onFrame(MessageKind.Debts, async (relay) => {
      const message = decodeDebtMessage({ kind: relay.kind, payload: relay.payload })
      if (relay.from !== 1 || message.type !== 0x01) return
      const { tab, reference } = decodeIou(message.offer.body)
      await w.c.db.run(
        'INSERT INTO repay_notes (tab, seq, reference, payee, reduction, request, status, checked_at) VALUES (?, 999, ?, ?, 1, NULL, 0, NULL)',
        [tab, reference, new Uint8Array(32).fill(7)],
      )
    })
    const [paid, received] = await run(w)
    expect([paid.status, received.status]).toEqual(['declined', 'declined'])
    expect(await notes(w, 'c')).toHaveLength(1)
  })

  it('a_lost_receipt_changes_nothing_because_the_cosigned_repay_is_the_receipt', async () => {
    const w = await remainderWorld()
    w.net.drop(MessageKind.Receipt)
    const [paid, received] = await run(w)
    expect([paid.status, received.status]).toEqual(['released', 'released'])
    expect((await notes(w, 'd'))[0].status).toBe(0)
  })

  it('a_replayed_release_is_a_duplicate_and_does_not_add_a_second_repay', async () => {
    const w = await remainderWorld()
    w.net.duplicateEvery(MessageKind.Payment)
    await run(w)
    expect(await notes(w, 'c')).toHaveLength(1)
    expect(await w.c.db.all('SELECT * FROM received_note')).toHaveLength(1)
  })

  it('a_debtor_without_funds_leaves_the_tab_and_holds_nothing', async () => {
    const w = await remainderWorld({ debtorBacking: 0n })
    const [paid] = await run(w)
    expect(paid).toMatchObject({ status: 'failed', reason: 'NoFunds' })
    expect((await remainderRow(w, 'd')).status).toBe(RemainderStatus.Due)
    expect(await w.d.db.all('SELECT * FROM outgoing_payment')).toHaveLength(0)
    expect(await notes(w, 'c')).toHaveLength(0)
  })

  it('skipping_marks_the_row_and_leaves_the_tab_untouched', async () => {
    const w = await remainderWorld()
    await skipRemainder(w.d.db, w.session, w.d.tab.tab)
    expect((await remainderRow(w, 'd')).status).toBe(RemainderStatus.Skipped)
    expect(await bal(w, 'd')).toBe(-w.before)
  })
})

describe('what the chain says about the note', () => {
  const sweepDeps = (w: World, noteState: (input: never) => Promise<string>) =>
    ({ ...w.c.sweepDeps(), noteState }) as never
  const says = (value: string) => async () => value

  it('settled_note_makes_repay_final', async () => {
    const w = await remainderWorld()
    const [paid] = await run(w)
    const seen = vi.fn(async () => 'settled')
    expect(await reconcileRepays(sweepDeps(w, seen))).toMatchObject({ settled: 1 })
    expect((await notes(w, 'c'))[0].status).toBe(1)
    expect(await bal(w, 'c')).toBe(w.before - 5n * U)
    expect(seen).toHaveBeenCalledWith({
      request: await w.requestOf(paid.messageId!),
      reference: paid.messageId,
      payee: w.c.tab.peerKey === undefined ? undefined : expect.anything(),
      reduction: 5n * U,
      mint: w.mint,
    })
  })

  it('failed_remainder_note_restores_tab_amount', async () => {
    const w = await remainderWorld()
    await run(w)
    await reconcileRepays(sweepDeps(w, says('void')))
    await reconcileRepays(sweepDeps(w, says('void')))
    expect((await notes(w, 'c'))[0].status).toBe(3)
    expect(await bal(w, 'c')).toBe(w.before)
    expect(await exp(w, 'c')).toBe(w.before)
  })

  it('void_needs_a_second_read_past_settle_end', async () => {
    const w = await remainderWorld()
    await run(w)
    await reconcileRepays(sweepDeps(w, says('void')))
    const afterFirst = (await notes(w, 'c'))[0]
    expect(afterFirst.status).toBe(0)
    expect(afterFirst.checked_at).not.toBeNull()
    await reconcileRepays(sweepDeps(w, says('settled')))
    expect((await notes(w, 'c'))[0].status).toBe(1)
  })

  it('a_settling_read_changes_nothing', async () => {
    const w = await remainderWorld()
    await run(w)
    expect(await reconcileRepays(sweepDeps(w, says('settling')))).toMatchObject({ settled: 0, voided: 0 })
    expect((await notes(w, 'c'))[0].status).toBe(0)
  })

  it('undecided_counts_nothing_and_keeps_the_tab_pending', async () => {
    const w = await remainderWorld()
    await run(w)
    await reconcileRepays(sweepDeps(w, says('undecided')))
    expect((await notes(w, 'c'))[0].status).toBe(5)
    expect(await bal(w, 'c')).toBe(w.before)
  })

  it('unreleased_note_voids_the_repay_after_the_window', async () => {
    const w = await remainderWorld()
    w.net.dropKind(MessageKind.Payment)
    await run(w)
    const deps = sweepDeps(w, says('void'))
    await reconcileRepays(deps)
    await reconcileRepays(deps)
    expect((await notes(w, 'c'))[0].status).toBe(0)
  })
})

describe('sweeps (N4)', () => {
  it('creditor_row_gets_its_request_from_the_received_note', async () => {
    const w = await remainderWorld()
    await run(w)
    expect((await notes(w, 'c'))[0].request).toBeNull()
    const seen = vi.fn(async () => 'settled' as const)
    await reconcileRepays({ ...w.c.sweepDeps(), noteState: seen })
    expect((await notes(w, 'c'))[0].request).not.toBeNull()
    expect(seen).toHaveBeenCalledTimes(1)
    expect((await notes(w, 'c'))[0].status).toBe(1)
  })

  it('bilateral_repay_row_is_swept_and_counts_after_settlement', async () => {
    const w = await remainderWorld()
    await run(w)
    await w.c.db.run('DELETE FROM netting_remainder')
    await reconcileRepays({ ...w.c.sweepDeps(), noteState: async () => 'settled' })
    expect((await notes(w, 'c'))[0].status).toBe(1)
  })

  it('a_row_stays_without_request_until_the_payment_arrives_and_is_unknown_after_the_window', async () => {
    const w = await remainderWorld()
    w.net.dropKind(MessageKind.Payment)
    await run(w)
    await reconcileRepays({ ...w.c.sweepDeps(), noteState: async () => 'settled' })
    expect((await notes(w, 'c'))[0].status).toBe(0)
    await reconcileRepays({ ...w.c.sweepDeps(), now: () => w.windowEnd + 1, noteState: async () => 'settled' })
    expect((await notes(w, 'c'))[0].status).toBe(4)
  })
})

describe('settling together and simplification', () => {
  const debts = (pairs: [number, number, bigint][]) =>
    pairs.map(([debtor, creditor, amount], i) => ({ id: String(i), debtor, creditor, amount }))

  it('settle_together_off_by_default', async () => {
    const w = await remainderWorld()
    await run(w)
    expect(await collectChains({ db: w.c.db, settleTogether: false }, w.session)).toEqual([])
  })

  it('longer_paths_are_proposed_with_their_via_list', () => {
    expect(
      proposeSimplification(
        3,
        debts([
          [0, 1, 5n * U],
          [1, 2, 5n * U],
        ]),
      ),
    ).toEqual([{ payer: 0, payee: 2, amount: 5n * U, via: [1] }])
    expect(
      proposeSimplification(
        4,
        debts([
          [0, 1, U],
          [1, 2, U],
          [2, 3, U],
        ]),
      ),
    ).toEqual([{ payer: 0, payee: 3, amount: U, via: [1, 2] }])
  })

  it('cap_bound_remainder_offers_no_simplification', () => {
    expect(
      proposeSimplification(
        3,
        debts([
          [0, 1, U],
          [1, 2, U],
          [2, 0, U],
        ]),
      ),
    ).toEqual([])
  })
})

describe('noteState: exactly these reads', () => {
  const SETTLE_END = 1_000
  const setup = async () => {
    const w = await remainderWorld()
    const [paid] = await run(w)
    const request = await w.requestOf(paid.messageId!)
    const issue = decodeIssue(hexToBytes(request.issue)).message
    const [start, end] = interval(issue)
    const accounts = new Map<string, { slot: bigint; owner: Uint8Array; data: Uint8Array }>()
    let time = 0
    let reads = 0
    const inputAddress = bytesToHex(recordAddress(PROGRAM, issueSlot(issue.lockSeq, start, end))!)
    const spent = (contentHash: Uint8Array, paid: boolean) =>
      concatBytes(
        sha256(utf8ToBytes('account:Spent')).slice(0, 8),
        contentHash,
        new Uint8Array(32),
        new Uint8Array(8),
        Uint8Array.of(paid ? 1 : 0),
      )
    const deps: NoteStateDeps = {
      chain: {
        account: async (address) => {
          reads++
          return accounts.get(bytesToHex(address)) ?? null
        },
        now: async () => time,
      },
      programId: PROGRAM,
      noteDomain: (await import('../../payment/testing/world')).NOTE_DOMAIN,
      settleEnd: () => SETTLE_END,
      closableAt: () => SETTLE_END + 100,
      history: async () => [],
    }
    const input = { request, reference: paid.messageId!, payee: w.c.tab.peerKey, reduction: 5n * U, mint: w.mint }
    return {
      w,
      input: { ...input, payee: (issue.owner as { key: Uint8Array }).key },
      deps,
      put: (hash: Uint8Array, isPaid: boolean) =>
        accounts.set(inputAddress, { slot: 1n, owner: PROGRAM, data: spent(hash, isPaid) }),
      content: content(encodeIssueBody(issue)),
      outputAddress: bytesToHex(recordAddress(PROGRAM, outputId(paid.messageId!, 0))!),
      putOutput: (hash: Uint8Array) =>
        accounts.set(bytesToHex(recordAddress(PROGRAM, outputId(paid.messageId!, 0))!), {
          slot: 1n,
          owner: PROGRAM,
          data: spent(hash, false),
        }),
      setTime: (value: number) => {
        time = value
      },
      reads: () => reads,
    }
  }

  it('note_state_is_settled_when_the_spent_record_holds_this_spend_paid', async () => {
    const s = await setup()
    s.put(s.content, true)
    expect(await noteState(s.input, s.deps)).toBe('settled')
  })

  it('onward_spent_repayment_note_counts_as_settled', async () => {
    const s = await setup()
    s.put(s.content, false)
    s.putOutput(new Uint8Array(32).fill(9))
    expect(await noteState(s.input, s.deps)).toBe('settled')
  })

  it('conflicting_spend_is_void_on_one_read', async () => {
    const s = await setup()
    s.put(new Uint8Array(32).fill(7), true)
    expect(await noteState(s.input, s.deps)).toBe('void')
  })

  it('no_record_before_settle_end_is_settling_and_a_record_free_note_is_never_void_by_absence_alone', async () => {
    const s = await setup()
    s.setTime(999)
    expect(await noteState(s.input, s.deps)).toBe('settling')
    s.setTime(1_050)
    expect(await noteState(s.input, s.deps)).toBe('void')
    s.setTime(1_100)
    expect(await noteState(s.input, s.deps)).toBe('undecided')
  })

  it('relayed_request_for_another_note_does_not_count', async () => {
    const s = await setup()
    s.put(s.content, true)
    expect(await noteState({ ...s.input, reference: new Uint8Array(32).fill(5) }, s.deps)).toBe('unknown')
    expect(s.reads()).toBe(0)
  })

  it('request_paying_less_than_the_reduction_or_to_another_payee_or_mint_does_not_count', async () => {
    const s = await setup()
    s.put(s.content, true)
    expect(await noteState({ ...s.input, reduction: s.input.reduction + 1n }, s.deps)).toBe('unknown')
    expect(await noteState({ ...s.input, payee: new Uint8Array(33).fill(2) }, s.deps)).toBe('unknown')
    expect(await noteState({ ...s.input, mint: new Uint8Array(32).fill(8) }, s.deps)).toBe('unknown')
    expect(s.reads()).toBe(0)
  })

  it('a_prefunded_system_account_is_not_a_spent_record', async () => {
    const s = await setup()
    s.setTime(999)
    s.put(s.content, true)
    const deps = {
      ...s.deps,
      chain: {
        ...s.deps.chain,
        account: async () => ({ slot: 1n, owner: new Uint8Array(32), data: new Uint8Array(0) }),
      },
    }
    expect(await noteState(s.input, deps)).toBe('settling')
  })

  it('a_spent_shaped_account_owned_by_another_program_is_not_a_record', async () => {
    const s = await setup()
    s.setTime(999)
    s.put(s.content, true)
    const foreign = async (address: Uint8Array) => {
      const account = await s.deps.chain.account(address)
      return account && { ...account, owner: new Uint8Array(32).fill(7) }
    }
    expect(await noteState(s.input, { ...s.deps, chain: { ...s.deps.chain, account: foreign } })).toBe('settling')
  })
})
