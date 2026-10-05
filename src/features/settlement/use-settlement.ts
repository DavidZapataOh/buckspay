import { useCallback, useState } from 'react'
import type { ReclaimRequest, SettlementGateway, SettlementRequest } from '../lock/gateway'
import { type Outcome, reclaim, settle } from './settle'

export type SettlementState = { step: 'idle' } | { step: 'sending' } | { step: 'done'; outcome: Outcome }

/**
 * Settles chains and reclaims outputs through the gateway, one at a time, and says how the last one
 * ended. It never signs: a chain carries the device signatures, and a reclaim comes signed.
 */
export function useSettlement(gateway: SettlementGateway | undefined) {
  const [state, setState] = useState<SettlementState>({ step: 'idle' })
  const run = useCallback(
    async (send: (gateway: SettlementGateway) => Promise<Outcome>): Promise<Outcome> => {
      if (!gateway) return { kind: 'unknown' }
      setState({ step: 'sending' })
      const outcome = await send(gateway)
      setState({ step: 'done', outcome })
      return outcome
    },
    [gateway],
  )
  return {
    state,
    settle: useCallback((request: SettlementRequest) => run((g) => settle(g, request)), [run]),
    reclaim: useCallback((request: ReclaimRequest) => run((g) => reclaim(g, request)), [run]),
  }
}
