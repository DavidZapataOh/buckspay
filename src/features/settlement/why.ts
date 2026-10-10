import { bytesToHex } from '@noble/hashes/utils.js'
import { copy, text } from '../payment/copy'
import type { SettlementReport } from './settle-held'

export type Why = { text: string; action?: 'settle-in-clear' }

const same = (a: Uint8Array, b: Uint8Array) => bytesToHex(a) === bytesToHex(b)

const busy = (reason: string) => {
  const said = copy.activity.serverReasons[reason]
  return said
    ? `${said} ${copy.activity.serverRetry}`
    : text(copy.activity.serverBusy, { code: reason === 'the gateway is busy' ? 'busy' : reason })
}

/** Why a note is still settling, from the last run: the reason and, when the person can fix it, the action. */
export function whyWaiting(report: SettlementReport | undefined, outputId: Uint8Array): Why | undefined {
  if (!report) return undefined
  if (report.blocked === 'wallet') return { text: copy.activity.needsWallet }
  if (report.blocked === 'gateway') return { text: copy.activity.noServer }
  if (report.notices.some((notice) => same(notice.outputId, outputId))) {
    return { text: copy.activity.waitsForYou, action: 'settle-in-clear' }
  }
  const stalled = report.stalled.find((s) => same(s.outputId, outputId))
  if (stalled?.kind === 'sign') return { text: copy.activity.stalledSign }
  if (stalled?.kind === 'offline') return { text: copy.activity.stalledOffline }
  const refused = report.refused.find((r) => same(r.outputId, outputId))
  if (refused) {
    if (refused.kind === 'no_token_account') return { text: copy.activity.noTokenAccount }
    if (refused.retryAt !== undefined) {
      const later = text(copy.activity.serverLater, { time: new Date(refused.retryAt * 1000).toLocaleString() })
      const said = refused.reason ? copy.activity.serverReasons[refused.reason] : undefined
      return { text: said ? `${said} ${later}` : later }
    }
    if (refused.kind === 'limited' || refused.kind === 'busy') return { text: busy(refused.reason ?? refused.kind) }
    if (refused.kind === 'below_minimum') return { text: copy.activity.serverMinimum }
    return { text: text(copy.activity.serverCannot, { reason: refused.reason ?? refused.kind }) }
  }
  if (report.private.some((p) => same(p.outputId, outputId))) return { text: copy.activity.privateProving }
  return report.retryIn === undefined ? undefined : { text: text(copy.activity.retryIn, { seconds: report.retryIn }) }
}
