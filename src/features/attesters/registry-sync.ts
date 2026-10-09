import type { Attester } from '../../protocol'
import { buildAttester, type RegistryRead, type TrustedAttester } from './registry'

/** One provider's read of an attester's registry entry and stake; `undefined` when it is not registered. */
export type RegistryReader = (id: number) => Promise<RegistryRead | undefined>

/**
 * The attesters a wallet believes after reading each trusted one from two independent providers: both
 * must answer the same. When a provider cannot be reached the wallet keeps what it believed before, as
 * of the time it believed it, so a stale registry is noticed instead of renewed.
 */
export async function syncRegistry({
  trusted,
  readers,
  now,
  previous = [],
}: {
  trusted: readonly TrustedAttester[]
  readers: readonly RegistryReader[]
  now: number
  previous?: readonly Attester[]
}): Promise<Attester[]> {
  if (readers.length < 2) return []
  const believed: Attester[] = []
  for (const entry of trusted) {
    const before = previous.find((attester) => attester.id === entry.id)
    const reads = await Promise.allSettled(readers.slice(0, 2).map((read) => read(entry.id)))
    if (reads.some((read) => read.status === 'rejected')) {
      if (before) believed.push(before)
      continue
    }
    const [a, b] = reads.map((read) => (read as PromiseFulfilledResult<RegistryRead | undefined>).value)
    const attester = a && b ? buildAttester(entry, a, b, now, before) : undefined
    if (attester) believed.push(attester)
  }
  return believed
}

/** A reader that gives up after `ms`, so one request that never answers cannot hold the sync for ever. */
export function withTimeout(read: RegistryReader, ms: number): RegistryReader {
  return (id) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RegistryTimeout')), ms)
      read(id).then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
}

/**
 * Runs `sync` until `usable` says the registry can be believed: after a failure, or a sync that left
 * nothing usable, it waits the next delay and tries again, and stops when the delays run out or the
 * caller is gone. Returns whether the registry is usable.
 */
export async function syncUntilUsable({
  sync,
  usable,
  delays,
  wait,
  stopped,
  onError,
}: {
  sync: () => Promise<void>
  usable: () => boolean
  delays: readonly number[]
  wait: (ms: number) => Promise<void>
  stopped: () => boolean
  onError?: (error: unknown) => void
}): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    if (stopped()) return false
    try {
      await sync()
    } catch (error) {
      onError?.(error)
    }
    if (usable()) return true
    if (attempt >= delays.length) return false
    await wait(delays[attempt])
  }
}
