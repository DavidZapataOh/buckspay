import { bytesToHex } from '@noble/hashes/utils.js'
import {
  decodeChallengeMessage,
  decodeResponseMessage,
  encodeChallengeMessage,
  encodeEvidence,
  encodeResponseMessage,
  verifyWitness,
  type WitnessBody,
} from '../../protocol'

export type ModemAvailability =
  { ready: true } | { ready: false; reason: 'permission-denied' | 'hardware-missing' | 'disabled' | 'unsupported' }

/** One acoustic message at a time: this phone's speaker and microphone. */
export type Modem = {
  check(): Promise<ModemAvailability>
  /** Resolves when the sound has ended. */
  emit(payload: Uint8Array, options?: { signal?: AbortSignal }): Promise<void>
  /** Returns the stop function. */
  listen(onMessage: (payload: Uint8Array) => void): Promise<() => Promise<void>>
}

export type Clock = {
  nowSeconds(): number
  nowMillis(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export type WitnessConfig = {
  receiverBudgetMs: number
  payerBudgetMs: number
  listenWindowMs: number
  skewSeconds: number
  maxVerifications: number
  maxSignaturesPerPayment: number
}

export const DEFAULT_CONFIG: WitnessConfig = {
  receiverBudgetMs: 30_000,
  payerBudgetMs: 60_000,
  listenWindowMs: 3_700,
  skewSeconds: 120,
  maxVerifications: 3,
  maxSignaturesPerPayment: 3,
}

export type WitnessStatus = 'seen' | 'not-seen' | 'unavailable'
/** `evidence` is the 176-byte evidence when seen. */
export type WitnessResult = { status: WitnessStatus; evidence?: Uint8Array }
export type PaymentFacts = { payerKey: Uint8Array; receiverKey: Uint8Array }

export type SessionDeps = {
  modem: Modem
  clock: Clock
  random: (length: number) => Uint8Array
  config: WitnessConfig
  witnessDomain: Uint8Array
  /** The band of the check, as the claim records it: `CHANNEL_ULTRASOUND` or `CHANNEL_AUDIBLE`. */
  channel: number
}
export type PayerDeps = SessionDeps & {
  sign(body: WitnessBody): Promise<Uint8Array>
  countSignature(paymentId: Uint8Array): Promise<number>
}

const QUIET_AFTER_ANSWER_MS = 1_000
const TICK_MS = 50

const sleepUnlessAborted = (deps: SessionDeps, ms: number, signal: AbortSignal) =>
  deps.clock.sleep(ms, signal).catch(() => undefined)

export async function runReceiver(
  paymentId: Uint8Array,
  facts: PaymentFacts,
  deps: SessionDeps,
  signal: AbortSignal,
): Promise<WitnessResult> {
  const { modem, clock, config } = deps
  if (!(await modem.check()).ready) return { status: 'unavailable' }

  const challenge = deps.random(8)
  const issuedAt = clock.nowSeconds()
  const wire = encodeChallengeMessage(paymentId, { challenge, issuedAt })
  const body: WitnessBody = { paymentId, ...facts, challenge, issuedAt, channel: deps.channel }
  let playing = false
  let verified = 0
  let evidence: Uint8Array | undefined
  const stopped = new AbortController()
  const cancel = () => stopped.abort()
  signal.addEventListener('abort', cancel, { once: true })

  const stop = await modem.listen((payload) => {
    if (playing || evidence || verified >= config.maxVerifications) return
    const signature = decodeResponseMessage(payload)
    if (!signature) return
    verified++
    try {
      verifyWitness(deps.witnessDomain, { ...body, signature })
    } catch {
      return
    }
    evidence = encodeEvidence({ ...body, signature })
    stopped.abort()
  })
  try {
    const deadline = clock.nowMillis() + config.receiverBudgetMs
    while (!signal.aborted && !stopped.signal.aborted && clock.nowMillis() < deadline) {
      playing = true
      try {
        await modem.emit(wire, { signal: stopped.signal })
      } catch {
        // A failed playback is retried on the next cycle.
      } finally {
        playing = false
      }
      await sleepUnlessAborted(deps, config.listenWindowMs, stopped.signal)
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    await stop()
  }
  return evidence ? { status: 'seen', evidence } : { status: 'not-seen' }
}

export async function runPayer(
  paymentId: Uint8Array,
  facts: PaymentFacts,
  deps: PayerDeps,
  signal: AbortSignal,
): Promise<WitnessResult> {
  const { modem, clock, config } = deps
  if (!(await modem.check()).ready) return { status: 'unavailable' }

  const answers = new Map<string, { response: Uint8Array; evidence: Uint8Array }>()
  let busy = false
  let evidence: Uint8Array | undefined
  let lastHeard = clock.nowMillis()

  async function answer(wire: Uint8Array) {
    const heard = decodeChallengeMessage(paymentId, wire)
    if (!heard) return
    lastHeard = clock.nowMillis()
    if (Math.abs(heard.issuedAt - clock.nowSeconds()) > config.skewSeconds) return
    const id = bytesToHex(wire)
    let known = answers.get(id)
    if (!known) {
      if ((await deps.countSignature(paymentId)) > config.maxSignaturesPerPayment) return
      const body: WitnessBody = { paymentId, ...facts, ...heard, channel: deps.channel }
      try {
        const signature = await deps.sign(body)
        known = { response: encodeResponseMessage(signature), evidence: encodeEvidence({ ...body, signature }) }
      } catch {
        return
      }
      answers.set(id, known)
    }
    try {
      await modem.emit(known.response, { signal })
      evidence = known.evidence
    } catch {
      // The receiver asks again.
    }
    lastHeard = clock.nowMillis()
  }

  const stop = await modem.listen((payload) => {
    if (busy) return
    busy = true
    answer(payload).finally(() => {
      busy = false
    })
  })
  try {
    const deadline = clock.nowMillis() + config.payerBudgetMs
    const quiet = config.listenWindowMs + QUIET_AFTER_ANSWER_MS
    while (!signal.aborted) {
      const now = clock.nowMillis()
      if (now >= deadline || (evidence && !busy && now - lastHeard >= quiet)) break
      await sleepUnlessAborted(deps, Math.min(TICK_MS, deadline - now), signal)
    }
  } finally {
    await stop()
  }
  return evidence ? { status: 'seen', evidence } : { status: 'not-seen' }
}
