import type { Clock, Modem, WitnessConfig } from '../session'

export { NOTE_DOMAIN, PAYMENT_ID, party, softSigner, WITNESS_DOMAIN } from '../../../protocol/testing/witness'

export const realClock: Clock = {
  nowSeconds: () => Math.floor(Date.now() / 1000),
  nowMillis: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'))
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        },
        { once: true },
      )
    }),
}

/** Short windows so a whole exchange takes a few hundred milliseconds. */
export const FAST: WitnessConfig = {
  receiverBudgetMs: 600,
  payerBudgetMs: 900,
  listenWindowMs: 80,
  skewSeconds: 120,
  maxVerifications: 3,
  maxSignaturesPerPayment: 3,
}

export type Acoustics = {
  /** Drops the n-th message played (0-based) when it returns true. */
  drop?: (index: number, payload: Uint8Array) => boolean
  airtimeMs?: number
  /** Whether a phone also hears its own playback, as a real microphone does. */
  echo?: boolean
}

/** Two phones in one room: what one plays the other hears, after `airtimeMs`. Test double, never shipped. */
export function createRoom(
  options: Acoustics = {},
): [Modem & { played: Uint8Array[] }, Modem & { played: Uint8Array[] }] {
  const listeners: [Set<(p: Uint8Array) => void>, Set<(p: Uint8Array) => void>] = [new Set(), new Set()]
  let count = 0
  const make = (self: 0 | 1) => {
    const played: Uint8Array[] = []
    return {
      played,
      async check() {
        return { ready: true as const }
      },
      async emit(payload: Uint8Array, opts?: { signal?: AbortSignal }) {
        played.push(payload)
        const index = count++
        await new Promise((resolve) => setTimeout(resolve, options.airtimeMs ?? 10))
        if (opts?.signal?.aborted) return
        if (options.drop?.(index, payload)) return
        for (const listener of listeners[1 - self]) listener(payload)
        if (options.echo) for (const listener of listeners[self]) listener(payload)
      },
      async listen(onMessage: (payload: Uint8Array) => void) {
        listeners[self].add(onMessage)
        return async () => {
          listeners[self].delete(onMessage)
        }
      },
    }
  }
  return [make(0), make(1)]
}
