import type { PrivateSettlementState } from './types'

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`

export const zkCopy = {
  title: 'Private settlement',
  settleNow: 'Settle now',
  downloadNow: 'Download 123 MB now',
  settleInClear: 'Settle now in clear',
  scope:
    'The people who held this note before you are hidden from chain observers when settled through ZK. The person who paid you and later holders still see its history.',
  clearPublishes: 'Settling in the clear publishes the keys, signatures and amounts of everyone who held this note.',
  state(state: PrivateSettlementState): string {
    switch (state.kind) {
      case 'needs-key':
        return `Downloading private settlement data · ${percent(state.progress)}`
      case 'waiting-for-charger':
        return `Preparing private settlement · ${state.proved} of ${state.total}`
      case 'proving':
        return `Preparing private settlement · ${state.proved} of ${state.total}`
      case 'ready':
        return 'Ready to settle privately'
      case 'submitting':
        return 'Settling privately'
      case 'settled':
        return 'Settled privately'
      case 'failed':
        switch (state.reason) {
          case 'stale-key':
            return 'Updating private settlement data'
          case 'expired':
            return 'This payment can no longer be settled. The payer may take it back.'
          case 'retry':
            return 'The server did not answer. This phone will try again.'
          case 'invalid':
            return 'This note could not be settled privately.'
        }
    }
  },
} as const
