import { equalBytes } from '@noble/curves/utils.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { NoteDb } from '../notes/db'
import type { SessionOutcome } from './member'
import { type RemainderTab, RemainderStatus } from './remainder'
import type { RemainderRow, RemainderState } from './remainder-section'
import { mineFrom } from './session-store'

const abs = (value: bigint) => (value < 0n ? -value : value)

/** The tabs of this phone with something left to pay once the session ended, and who they are with. */
export async function remainderTabsOf(
  db: NoteDb,
  input: { session: Uint8Array; deviceKey: Uint8Array; mint: Uint8Array; outcome: SessionOutcome },
): Promise<RemainderTab[]> {
  const { outcome } = input
  if (outcome.status !== 'nothing' && outcome.status !== 'agreed') return []
  const mine = await mineFrom(db, {
    index: 0,
    session: input.session,
    mint: input.mint,
    deviceKey: input.deviceKey,
    ephemeral: new Uint8Array(32),
  })
  const tabs: RemainderTab[] = []
  for (const tab of mine.tabs) {
    if (tab.pending) continue
    const base = { tab: tab.tab, peerKey: tab.peer, state: tab.state }
    if (outcome.status === 'nothing') {
      const peer = outcome.peers.find((p) => equalBytes(p.key, tab.peer))
      if (peer)
        tabs.push({
          ...base,
          peer: peer.index,
          role: tab.balance < 0n ? 'debtor' : 'creditor',
          remaining: abs(tab.balance),
        })
    } else {
      const seen = outcome.view.tabs.find((v) => equalBytes(v.tab, tab.tab))
      if (seen && seen.remaining > 0n)
        tabs.push({
          ...base,
          peer: seen.peerIndex,
          role: seen.direction === 'iOwe' ? 'debtor' : 'creditor',
          remaining: seen.remaining,
        })
    }
  }
  return tabs
}

/** What the payment of a repayment came to, read from the sweep: 0 settling, 1 settled, 3 void, 4 unknown, 5 undecided. */
const AFTER_RELEASE: Record<number, RemainderState> = { 1: 'settled', 3: 'void', 4: 'unknown', 5: 'undecided' }

/** One row for every tab of the session that still has a remainder, in the words the screen uses. */
export async function loadRemainderRows(
  db: NoteDb,
  session: Uint8Array,
  tabs: readonly RemainderTab[],
): Promise<RemainderRow[]> {
  const stored = await db.all<{ tab: Uint8Array; status: number; message_id: Uint8Array | null }>(
    'SELECT tab, status, message_id FROM netting_remainder WHERE session = ?',
    [session],
  )
  const rows: RemainderRow[] = []
  for (const tab of tabs) {
    const row = stored.find((r) => equalBytes(r.tab, tab.tab))
    if (!row || row.status === RemainderStatus.Skipped) continue
    let state: RemainderState =
      row.status === RemainderStatus.Due ? 'due' : row.status === RemainderStatus.Repaid ? 'sending' : 'released'
    if (row.status === RemainderStatus.Released && row.message_id) {
      const [note] = await db.all<{ status: number }>(
        'SELECT status FROM repay_notes WHERE tab = ? AND reference = ?',
        [tab.tab, row.message_id],
      )
      state = (note && AFTER_RELEASE[note.status]) ?? state
    }
    rows.push({ tab: bytesToHex(tab.tab), role: tab.role, amount: tab.remaining, state })
  }
  return rows
}
