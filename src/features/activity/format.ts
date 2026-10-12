import { formatMoney } from '../../i18n/format'
import { i18n, currentLanguage, translateIfKnown } from '../../i18n'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { safetyCode } from '../../payment/messages'

import type { ActivityRow } from '../notes/activity'

/** The route parameter of a row: which table it is from, and its id. */
export const activityId = (row: Pick<ActivityRow, 'kind' | 'id'>) => `${row.kind}-${bytesToHex(row.id)}`

export function parseActivityId(id: string): { kind: ActivityRow['kind']; id: Uint8Array } | undefined {
  const match = /^(paid|received)-([0-9a-f]{64})$/.exec(id)
  return match ? { kind: match[1] as ActivityRow['kind'], id: hexToBytes(match[2]) } : undefined
}

/** The word for a row's state. */
export const statusWord = (row: Pick<ActivityRow, 'state' | 'handedTo'>) =>
  row.state.startsWith('remote-')
    ? (translateIfKnown(`remote:status.${row.state.slice(7)}`) ?? row.state)
    : row.state === 'relay-handed'
      ? row.handedTo === 1
        ? i18n.t('payment:activity.relayHandedOne')
        : i18n.t('payment:activity.relayHanded', { count: String(row.handedTo ?? 0) })
      : (translateIfKnown(`payment:activity.status.${row.state}`) ?? row.state)

/** How a state stands, for the colour and the icon beside its word. */
export function statusKind(state: string): 'done' | 'waiting' | 'problem' | 'info' {
  if (state.startsWith('remote-')) {
    const known = state.slice(7)
    return known === 'delivered' ? 'done' : known === 'expired' || known === 'refused' ? 'problem' : 'info'
  }
  if (['settled', 'confirmed', 'change', 'spent'].includes(state)) return 'done'
  if (['rejected', 'lost', 'conflicted', 'expired', 'abandoned'].includes(state)) return 'problem'
  return 'waiting'
}

/** A row of the list in two lines: the amount that moved, and what became of it (and to whom, when far away). */
export function rowParts(row: ActivityRow, symbol: string, decimals: number): { title: string; detail: string } {
  const values = { amount: formatMoney(row.amount, decimals, currentLanguage()), symbol }
  const status = statusWord(row)
  return {
    title: i18n.t(row.kind === 'paid' ? 'payment:activity.paidTitle' : 'payment:activity.receivedTitle', values),
    detail: row.remote
      ? i18n.t('payment:activity.toWho', { who: row.payee ?? i18n.t('remote:someone'), status })
      : status,
  }
}

/** "Paid 5.00 USDC · phone ABCD-EF23 · Confirmed" or "Received 5.00 USDC · Settled". */
export function sentence(row: ActivityRow, symbol: string, decimals: number): string {
  const values = { amount: formatMoney(row.amount, decimals, currentLanguage()), symbol, status: statusWord(row) }
  if (row.remote) {
    return i18n.t('remote:paidFar', { ...values, payee: row.payee ?? i18n.t('remote:someone') })
  }
  return row.kind === 'paid'
    ? i18n.t('payment:activity.paid', { ...values, code: safetyCode({ type: 'device', key: row.counterparty }) })
    : i18n.t('payment:activity.received', values)
}
