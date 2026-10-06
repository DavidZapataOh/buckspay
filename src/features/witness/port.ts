import { bytesToHex } from '@noble/hashes/utils.js'
import { type PayerDeps, type PaymentFacts, runPayer, runReceiver, type WitnessResult } from './session'

export type WitnessRole = 'payer' | 'receiver'

/** What the flows call once a payment is on its way (payer) or stored (receiver). */
export type WitnessPort = {
  attach(messageId: Uint8Array, role: WitnessRole): Promise<WitnessResult>
  cancel(messageId: Uint8Array): void
}

export type WitnessStore = {
  facts(messageId: Uint8Array, role: WitnessRole): Promise<PaymentFacts | null>
  stored(messageId: Uint8Array, role: WitnessRole): Promise<Uint8Array | null>
  record(messageId: Uint8Array, role: WitnessRole, evidence: Uint8Array): Promise<void>
  countSignature(messageId: Uint8Array): Promise<number>
}

const ROLES: WitnessRole[] = ['payer', 'receiver']
const keyOf = (messageId: Uint8Array, role: WitnessRole) => `${role}:${bytesToHex(messageId)}`

export function createWitnessPort({
  store,
  ...deps
}: Omit<PayerDeps, 'countSignature'> & { store: WitnessStore }): WitnessPort {
  const running = new Map<string, { result: Promise<WitnessResult>; abort: AbortController }>()

  async function run(messageId: Uint8Array, role: WitnessRole, signal: AbortSignal): Promise<WitnessResult> {
    const stored = await store.stored(messageId, role)
    if (stored) return { status: 'seen', evidence: stored }
    const facts = await store.facts(messageId, role)
    if (!facts) return { status: 'unavailable' }
    const result =
      role === 'receiver'
        ? await runReceiver(messageId, facts, deps, signal)
        : await runPayer(messageId, facts, { ...deps, countSignature: store.countSignature }, signal)
    if (result.status === 'seen' && result.evidence) await store.record(messageId, role, result.evidence)
    return result
  }

  return {
    attach(messageId, role) {
      const key = keyOf(messageId, role)
      const existing = running.get(key)
      if (existing) return existing.result
      const abort = new AbortController()
      const result = run(messageId, role, abort.signal).finally(() => running.delete(key))
      running.set(key, { result, abort })
      return result
    },
    cancel(messageId) {
      for (const role of ROLES) running.get(keyOf(messageId, role))?.abort.abort()
    },
  }
}
