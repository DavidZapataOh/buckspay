import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { NettingStatement } from '../../protocol'
import { setRepayStatus } from '../debts/store'
import type { SettlementRequest } from '../lock/gateway'
import { decodeBundle } from '../../payment/messages'
import type { NoteDb } from '../notes/db'
import { settlementRequest } from '../settlement/chain'
import type { NoteOutcome, NoteStateInput } from './remainder'
import { type SweepCounts, sweepSessions } from './session-store'

export type SweepDeps = {
  db: NoteDb
  now: () => number
  nettingOutcome: (statement: NettingStatement) => Promise<'recorded' | 'void' | 'pending' | 'undecided'>
  noteState: (input: NoteStateInput) => Promise<NoteOutcome>
  /** The last second the payment of a Repay can still reach its payee. */
  paymentWindowEnds?: (reference: Uint8Array, repaidAt: number) => number
  /** The received note whose payment id is `reference`. */
  receivedPayment: (reference: Uint8Array) => Promise<{ request: SettlementRequest } | undefined>
  mintOf?: (tab: Uint8Array) => Promise<Uint8Array>
}

/** A payment that was not released within the life of a note cannot arrive any more. */
export const PAYMENT_WINDOW_SECS = 72 * 3600

/** Looks up the received note whose payment id is `reference` and returns its settlement request. */
export const receivedPaymentIn =
  (db: NoteDb) =>
  async (reference: Uint8Array): Promise<{ request: SettlementRequest } | undefined> => {
    const [row] = await db.all<{ bundle: Uint8Array }>(
      'SELECT bundle FROM received_note WHERE message_id = ? LIMIT 1',
      [reference],
    )
    if (!row) return undefined
    const { issue, spends } = decodeBundle(row.bundle)
    return { request: settlementRequest({ issue, spends }) }
  }

export type RepaySweep = { settled: number; voided: number; unknown: number; undecided: number }

type RepayRow = {
  tab: Uint8Array
  seq: number
  reference: Uint8Array
  payee: Uint8Array
  reduction: number | bigint
  request: Uint8Array | null
  status: number
  checked_at: number | null
}

const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as SettlementRequest

async function mintOfTab(db: NoteDb, tab: Uint8Array): Promise<Uint8Array> {
  const [row] = await db.all<{ mint: Uint8Array }>('SELECT mint FROM tabs WHERE tab = ?', [tab])
  return row.mint
}

/**
 * Every repayment not yet final (settling, unknown, undecided), bilateral or from a session. A row with no request
 * first takes it from the note received for that payment; a void read waits for a second one on a later sweep.
 */
export async function reconcileRepays(
  deps: Pick<SweepDeps, 'db' | 'now' | 'noteState' | 'paymentWindowEnds' | 'receivedPayment' | 'mintOf'>,
): Promise<RepaySweep> {
  const counts: RepaySweep = { settled: 0, voided: 0, unknown: 0, undecided: 0 }
  const { db } = deps
  const rows = await db.all<RepayRow>(
    'SELECT tab, seq, reference, payee, reduction, request, status, checked_at FROM repay_notes WHERE status IN (0, 4, 5) ORDER BY tab, seq',
  )
  for (const row of rows) {
    let request = row.request
    if (!request) {
      const received = await deps.receivedPayment(row.reference)
      if (received) {
        request = utf8ToBytes(JSON.stringify(received.request))
        await db.run('UPDATE repay_notes SET request = ? WHERE tab = ? AND reference = ?', [
          request,
          row.tab,
          row.reference,
        ])
      } else {
        const [repaid] = await db.all<{ recorded_at: number }>(
          'SELECT recorded_at FROM tab_states WHERE tab = ? AND seq = ?',
          [row.tab, row.seq],
        )
        const ends = (deps.paymentWindowEnds ?? ((_r, at) => at + PAYMENT_WINDOW_SECS))(
          row.reference,
          repaid?.recorded_at ?? 0,
        )
        if (deps.now() >= ends && row.status !== 4) {
          await setRepayStatus(db, row.tab, row.reference, 'unknown', deps.now())
          counts.unknown++
        }
        continue
      }
    }
    const outcome = await deps.noteState({
      request: decode(request),
      reference: row.reference,
      payee: row.payee,
      reduction: BigInt(row.reduction),
      mint: await (deps.mintOf ?? ((tab) => mintOfTab(db, tab)))(row.tab),
    })
    const now = deps.now()
    if (outcome === 'settled') {
      await setRepayStatus(db, row.tab, row.reference, 'settled', now)
      counts.settled++
    } else if (outcome === 'void') {
      if (row.status === 0 && row.checked_at !== null) {
        await setRepayStatus(db, row.tab, row.reference, 'void', now)
        counts.voided++
      } else {
        await setRepayStatus(db, row.tab, row.reference, 'settling', now)
      }
    } else if (outcome === 'undecided') {
      await setRepayStatus(db, row.tab, row.reference, 'undecided', now)
      counts.undecided++
    } else if (outcome === 'unknown') {
      await setRepayStatus(db, row.tab, row.reference, 'unknown', now)
      counts.unknown++
    }
  }
  return counts
}

/** Sessions at approved, agreed or undecided are read from the chain; then every repayment. One call per run. */
export async function sweepAll(deps: SweepDeps): Promise<{ sessions: SweepCounts; repays: RepaySweep }> {
  const sessions = await sweepSessions(deps.db, { nettingOutcome: deps.nettingOutcome }, deps.now(), { restart: false })
  return { sessions, repays: await reconcileRepays(deps) }
}
