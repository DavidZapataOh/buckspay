import { i18n } from '../../i18n'
import type { PrivateSettlementState } from './types'

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`

/** The words of a private settlement in progress. */
export function privateSettlementText(state: PrivateSettlementState): string {
  switch (state.kind) {
    case 'needs-key':
      return i18n.t('zk:state.needsKey', { percent: percent(state.progress) })
    case 'waiting-for-charger':
    case 'proving':
      return i18n.t('zk:state.preparing', { proved: state.proved, total: state.total })
    case 'ready':
      return i18n.t('zk:state.ready')
    case 'submitting':
      return i18n.t('zk:state.submitting')
    case 'settled':
      return i18n.t('zk:state.settled')
    case 'failed':
      switch (state.reason) {
        case 'stale-key':
          return i18n.t('zk:state.failed.staleKey')
        case 'expired':
          return i18n.t('zk:state.failed.expired')
        case 'retry':
          return i18n.t('zk:state.failed.retry')
        case 'invalid':
          return i18n.t('zk:state.failed.invalid')
      }
  }
}
