import type { WitnessPolicy } from './policy'
import type { WitnessResult } from './session'

export const MAX_ATTEMPTS = 3

export type WitnessPhase = 'off' | 'checking' | 'seen' | 'not-seen' | 'unavailable' | 'skipped'
export type WitnessState = { phase: WitnessPhase; attempts: number; evidence?: Uint8Array; continued: boolean }
export type WitnessEvent =
  | { type: 'start'; policy: WitnessPolicy }
  | { type: 'result'; result: WitnessResult }
  | { type: 'retry' }
  | { type: 'skip' }
  | { type: 'continue' }

export const initialWitnessState: WitnessState = { phase: 'off', attempts: 0, continued: false }

export const canRetry = (state: WitnessState) => state.phase === 'not-seen' && state.attempts < MAX_ATTEMPTS

export function witnessReducer(state: WitnessState, event: WitnessEvent): WitnessState {
  switch (event.type) {
    case 'start':
      return state.attempts > 0 || event.policy === 'off' ? state : { ...state, phase: 'checking', attempts: 1 }
    case 'result':
      return state.phase === 'checking'
        ? { ...state, phase: event.result.status, evidence: event.result.evidence }
        : state
    case 'retry':
      return canRetry(state) ? { ...state, phase: 'checking', attempts: state.attempts + 1 } : state
    case 'skip':
      return state.phase === 'checking' ? { ...state, phase: 'skipped' } : state
    case 'continue':
      return { ...state, continued: true }
  }
}

/** Only a required check holds the receiver's "all good" back. */
export const mayReleaseNow = (policy: WitnessPolicy, state: WitnessState) =>
  policy !== 'require' || state.phase === 'seen' || state.continued
