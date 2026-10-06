import type { TransportId } from '../../transport/types'

export type WitnessPolicy = 'off' | 'auto' | 'require'

export type WitnessSettings = {
  /** Receiver: ask the other phone for the check. */
  ask: boolean
  /** Receiver: from this amount (minor units) wait for the check before saying all is well; null: never. */
  requireFrom: bigint | null
  /** Payer: answer a nearby check when the microphone permission is granted. */
  answer: boolean
}

export type PolicyInput = {
  role: 'payer' | 'receiver'
  transport: TransportId
  amount: bigint
  settings: WitnessSettings
  /** The receiver's request says it will ask. */
  requested?: boolean
}

export function witnessPolicy({ role, transport, amount, settings, requested }: PolicyInput): WitnessPolicy {
  if (role === 'payer') return settings.answer || requested ? 'auto' : 'off'
  if (settings.requireFrom !== null && amount >= settings.requireFrom) return 'require'
  return settings.ask && transport !== 'nfc' ? 'auto' : 'off'
}
