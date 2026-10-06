import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { nowSeconds, usePayments } from '../payment/payments-provider'
import { openPairing, type PairingRole } from '../nearby/handoff'
import type { PointPairing } from './payloads'
import { PointSync, type SyncStatus } from './point-sync'
import { activePairing, savePairing } from './store'

export type PointMode = { pairing: PointPairing; sync: PointSync }

export type PointModeApi = {
  /** The event this phone takes payments for as a point, or null when it is an ordinary receiver. */
  mode: PointMode | null
  status: SyncStatus
  enter: (pairing: PointPairing) => Promise<void>
  leave: () => Promise<void>
  /** Pairs with another point over Nearby and starts syncing with it. */
  link: (role: PairingRole) => Promise<void>
}

const NONE: SyncStatus = { peers: 0, syncedAt: null }
const PointModeContext = createContext<PointModeApi | undefined>(undefined)

/** Holds the point mode of this phone: its pairing, the sessions with the other points and what they last said. */
export function PointModeProvider({ children }: { children: ReactNode }) {
  const { db, domains } = usePayments()
  const [mode, setMode] = useState<PointMode | null>(null)
  const [status, setStatus] = useState<SyncStatus>(NONE)
  const current = useRef<PointMode | null>(null)

  const start = useCallback(
    (pairing: PointPairing) => {
      if (!db) throw new Error('The payments store is not open')
      const sync = new PointSync({
        db,
        pairing,
        noteDomain: domains.noteDomain,
        from: crypto.getRandomValues(new Uint8Array(16)),
        now: nowSeconds,
        onChange: setStatus,
      })
      sync.start()
      current.current = { pairing, sync }
      setMode(current.current)
      setStatus(NONE)
    },
    [db, domains.noteDomain],
  )

  const leave = useCallback(async () => {
    const running = current.current
    current.current = null
    setMode(null)
    setStatus(NONE)
    await running?.sync.close()
  }, [])

  const enter = useCallback(
    async (pairing: PointPairing) => {
      if (!db) throw new Error('The payments store is not open')
      await leave()
      await savePairing(db, 'point', pairing)
      start(pairing)
    },
    [db, leave, start],
  )

  const link = useCallback(async (role: PairingRole) => {
    const transport = await openPairing(role)
    current.current?.sync.attach(transport)
  }, [])

  useEffect(() => {
    if (!db) return
    let live = true
    void activePairing(db, nowSeconds()).then((pairing) => {
      if (live && pairing && !current.current) start(pairing)
    })
    return () => {
      live = false
    }
  }, [db, start])

  const value = useMemo(() => ({ mode, status, enter, leave, link }), [mode, status, enter, leave, link])
  return <PointModeContext.Provider value={value}>{children}</PointModeContext.Provider>
}

export function usePointMode(): PointModeApi {
  const api = useContext(PointModeContext)
  if (!api) throw new Error('usePointMode needs a PointModeProvider')
  return api
}
