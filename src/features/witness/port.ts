import { bytesToHex } from '@noble/hashes/utils.js'
import { type PayerDeps, type PaymentFacts, runPayer, runReceiver, type WitnessResult } from './session'

export type WitnessRole = 'payer' | 'receiver'

/** What the flows call once a payment is on its way (payer) or stored (receiver). */
export type WitnessPort = {
  /** `band` is the one the check runs on; the payer takes it from the request, the receiver from its settings. */
  attach(messageId: Uint8Array, role: WitnessRole, band?: 'ultrasound' | 'audible'): Promise<WitnessResult>
  cancel(messageId: Uint8Array): void
}

export type WitnessStore = {
  facts(messageId: Uint8Array, role: WitnessRole): Promise<PaymentFacts | null>
  stored(messageId: Uint8Array, role: WitnessRole): Promise<Uint8Array | null>
  record(messageId: Uint8Array, role: WitnessRole, evidence: Uint8Array): Promise<void>
  countSignature(messageId: Uint8Array): Promise<number>
}

const RECORD_ATTEMPTS = 3
const RECORD_RETRY_MS = 250
const ROLES: WitnessRole[] = ['payer', 'receiver']
const keyOf = (messageId: Uint8Array, role: WitnessRole) => `${role}:${bytesToHex(messageId)}`

export function createWitnessPort({
  store,
  ...deps
}: Omit<PayerDeps, 'countSignature'> & { store: WitnessStore }): WitnessPort {
  const running = new Map<string, { result: Promise<WitnessResult>; abort: AbortController }>()

  async function keep(messageId: Uint8Array, role: WitnessRole, evidence: Uint8Array) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await store.record(messageId, role, evidence)
      } catch (error) {
        if (attempt === RECORD_ATTEMPTS) throw error
        console.warn(`witness ${role} could not record the evidence (attempt ${attempt}): ${String(error)}`)
        await deps.clock.sleep(RECORD_RETRY_MS)
      }
    }
  }

  async function run(messageId: Uint8Array, role: WitnessRole, signal: AbortSignal): Promise<WitnessResult> {
    const stored = await store.stored(messageId, role)
    if (stored) return { status: 'seen', evidence: stored }
    const facts = await store.facts(messageId, role)
    if (!facts) return { status: 'unavailable' }
    const result =
      role === 'receiver'
        ? await runReceiver(messageId, facts, deps, signal)
        : await runPayer(messageId, facts, { ...deps, countSignature: store.countSignature }, signal)
    if (result.status === 'seen' && result.evidence) await keep(messageId, role, result.evidence)
    return result
  }

  return {
    attach(messageId, role) {
      const key = keyOf(messageId, role)
      const existing = running.get(key)
      if (existing) return existing.result
      const abort = new AbortController()
      const entry = {
        result: run(messageId, role, abort.signal).finally(() => {
          if (running.get(key) === entry) running.delete(key)
        }),
        abort,
      }
      running.set(key, entry)
      return entry.result
    },
    cancel(messageId) {
      for (const role of ROLES) {
        const key = keyOf(messageId, role)
        const entry = running.get(key)
        entry?.abort.abort()
        running.delete(key)
      }
    },
  }
}
