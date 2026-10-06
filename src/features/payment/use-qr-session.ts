import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { QrTransport } from '../../transport/qr/qr-transport'
import type { TransferProgress } from '../../transport/types'
import { installE2eScan } from '../qr/e2e-source'
import { createQrSurface } from '../qr/qr-surface'
import { createTextBus } from '../qr/text-bus'

/**
 * One QR transport with the surface it shows on and the bus the camera, a paste or an end-to-end
 * harness pushes texts into. It is closed when the screen that owns it goes.
 */
export function useQrSession() {
  const session = useMemo(() => {
    const surface = createQrSurface()
    const bus = createTextBus()
    return { surface, push: bus.push, transport: new QrTransport({ surface, scanner: bus.source }) }
  }, [])
  const [progress, setProgress] = useState<TransferProgress>()
  const texts = useSyncExternalStore(session.surface.subscribe, session.surface.getSnapshot)

  useEffect(() => installE2eScan(session.push), [session])
  useEffect(
    () =>
      session.transport.subscribe((event) => {
        if (event.type === 'progress' && event.direction === 'in') setProgress(event)
      }),
    [session],
  )
  useEffect(
    () => () => {
      void session.transport.close()
    },
    [session],
  )

  return {
    transport: session.transport,
    /** Hands a scanned or pasted text to whoever is waiting for one. */
    push: session.push,
    /** What the screen shows now, as the texts of one message in a loop, or none. */
    texts,
    progress,
    clear: () => {
      session.surface.clear()
      setProgress(undefined)
    },
  }
}
