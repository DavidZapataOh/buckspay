import { formatDateTime } from '../../i18n/format'
import { i18n, currentLanguage, translateIfKnown } from '../../i18n'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { SettlementReport } from './settle-held'

export type Why = { text: string; action?: 'settle-in-clear'; code?: string }

const same = (a: Uint8Array, b: Uint8Array) => bytesToHex(a) === bytesToHex(b)

const busy = (reason: string): Why => {
  const said = translateIfKnown(`payment:activity.serverReasons.${reason}`)
  const code = reason === 'the gateway is busy' ? 'busy' : reason
  return {
    text: said ? `${said} ${i18n.t('payment:activity.serverRetry')}` : i18n.t('payment:activity.serverBusy'),
    code,
  }
}

/** Why a note is still settling, from the last run: the reason and, when the person can fix it, the action. */
export function whyWaiting(report: SettlementReport | undefined, outputId: Uint8Array): Why | undefined {
  if (!report) return undefined
  if (report.blocked === 'wallet') return { text: i18n.t('payment:activity.needsWallet') }
  if (report.blocked === 'gateway') return { text: i18n.t('payment:activity.noServer') }
  if (report.notices.some((notice) => same(notice.outputId, outputId))) {
    return { text: i18n.t('payment:activity.waitsForYou'), action: 'settle-in-clear' }
  }
  const stalled = report.stalled.find((s) => same(s.outputId, outputId))
  if (stalled?.kind === 'sign') return { text: i18n.t('payment:activity.stalledSign') }
  if (stalled?.kind === 'offline') return { text: i18n.t('payment:activity.stalledOffline') }
  const refused = report.refused.find((r) => same(r.outputId, outputId))
  if (refused) {
    if (refused.kind === 'no_token_account') return { text: i18n.t('payment:activity.noTokenAccount') }
    if (refused.retryAt !== undefined) {
      const later = i18n.t('payment:activity.serverLater', { time: formatDateTime(refused.retryAt, currentLanguage()) })
      const said = refused.reason ? translateIfKnown(`payment:activity.serverReasons.${refused.reason}`) : undefined
      return { text: said ? `${said} ${later}` : later, code: refused.reason }
    }
    if (refused.kind === 'limited' || refused.kind === 'busy') return busy(refused.reason ?? refused.kind)
    if (refused.kind === 'below_minimum') return { text: i18n.t('payment:activity.serverMinimum') }
    return { text: i18n.t('payment:activity.serverCannot'), code: refused.reason ?? refused.kind }
  }
  if (report.private.some((p) => same(p.outputId, outputId))) return { text: i18n.t('payment:activity.privateProving') }
  return report.retryIn === undefined
    ? undefined
    : { text: i18n.t('payment:activity.retryIn', { seconds: report.retryIn }) }
}
