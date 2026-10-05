import { useCallback, useState } from 'react'
import type { ReclaimRequest, SettlementGateway, SettlementRequest } from '../lock/gateway'
import { type ClaimOutcome, fileClaim, type Outcome, reclaim, settle } from './settle'

export type SettlementState =
  { step: 'idle' } | { step: 'sending' } | { step: 'done'; outcome: Outcome; claim?: ClaimOutcome }

/**
 * Settles chains and reclaims outputs through the gateway, one at a time, and says how the last one
 * ended. It never signs: a chain carries the device signatures, and a reclaim comes signed. A
 * settlement that fails because another message was recorded first is a loss, and the hook files
 * it by itself: nothing is paid for filing, so the user is not asked.
 */
export function useSettlement(gateway: SettlementGateway | undefined) {
  const [state, setState] = useState<SettlementState>({ step: 'idle' })
  const run = useCallback(
    async (send: (gateway: SettlementGateway) => Promise<Outcome>, lost?: SettlementRequest): Promise<Outcome> => {
      if (!gateway) return { kind: 'unknown' }
      setState({ step: 'sending' })
      const outcome = await send(gateway)
      const conflict = outcome.kind === 'refused' && outcome.refusal.kind === 'conflict'
      const claim = lost && conflict ? await fileClaim(gateway, lost) : undefined
      setState(claim ? { step: 'done', outcome, claim } : { step: 'done', outcome })
      return outcome
    },
    [gateway],
  )
  return {
    state,
    settle: useCallback((request: SettlementRequest) => run((g) => settle(g, request), request), [run]),
    reclaim: useCallback((request: ReclaimRequest) => run((g) => reclaim(g, request)), [run]),
  }
}
