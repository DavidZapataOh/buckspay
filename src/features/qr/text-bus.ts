import type { TextSource } from '../../transport/qr/qr-transport'

/** Fans scanned texts out to whoever waits now; a text nobody waits for is dropped, never replayed. */
export function createTextBus(): { source: TextSource; push(text: string): void } {
  const listeners = new Set<(text: string) => void>()
  return {
    source: { subscribe: (listener) => (listeners.add(listener), () => void listeners.delete(listener)) },
    push: (text) => {
      for (const listener of [...listeners]) listener(text)
    },
  }
}
