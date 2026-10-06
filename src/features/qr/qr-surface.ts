import type { QrSurface } from '../../transport/qr/qr-transport'

export type ObservableQrSurface = QrSurface & {
  subscribe(listener: () => void): () => void
  getSnapshot(): readonly string[] | null
}

/** The store `QrTransport` presents into and `QrPresenter` reads (a `useSyncExternalStore` source). */
export function createQrSurface(): ObservableQrSurface {
  const listeners = new Set<() => void>()
  let texts: readonly string[] | null = null
  const set = (next: readonly string[] | null) => {
    if (next === texts) return
    texts = next
    listeners.forEach((listener) => listener())
  }
  return {
    present: set,
    clear: () => set(null),
    getSnapshot: () => texts,
    subscribe: (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
  }
}
