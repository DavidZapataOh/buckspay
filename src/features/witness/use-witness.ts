import { useCallback, useEffect, useReducer } from 'react'
import type { Band } from './app-port'
import type { WitnessPort, WitnessRole } from './port'
import type { WitnessPolicy } from './policy'
import { canRetry, initialWitnessState, witnessReducer } from './witness-state'

/**
 * Runs the nearby check of one payment for a screen: one attempt when the policy asks for it, a new one on
 * `retry`, and the attempt is cancelled when the screen is left or the check is skipped.
 */
export function useWitness({
  role,
  messageId,
  policy,
  port,
  band,
}: {
  role: WitnessRole
  messageId: Uint8Array
  policy: WitnessPolicy
  port: WitnessPort
  band?: Band
}) {
  const [state, dispatch] = useReducer(witnessReducer, initialWitnessState)
  useEffect(() => dispatch({ type: 'start', policy }), [policy])

  const attempt = state.phase === 'checking' ? state.attempts : 0
  useEffect(() => {
    if (!attempt) return
    let current = true
    void port.attach(messageId, role, band).then((result) => current && dispatch({ type: 'result', result }))
    return () => {
      current = false
      port.cancel(messageId)
    }
  }, [attempt, messageId, role, port, band])

  return {
    state,
    skip: useCallback(() => dispatch({ type: 'skip' }), []),
    retry: useCallback(() => dispatch({ type: 'retry' }), []),
    continueAnyway: useCallback(() => dispatch({ type: 'continue' }), []),
    canRetry: role === 'receiver' && canRetry(state),
  }
}
