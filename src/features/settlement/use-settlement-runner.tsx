import { getAddressEncoder } from '@solana/kit'
import { addNetworkStateListener } from 'expo-network'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { signSpend } from '../../keys'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { BUILD_GATEWAY } from '../lock/gateway'
import { unsettledSummary, type Unsettled } from '../notes/ledger'
import { nowSeconds, usePayments } from '../payment/payments-provider'
import { acknowledgeLabel, isLabelAcknowledged } from './label'
import { settleHeld, type SettlementReport } from './settle-held'

export type Settlement = {
  /** What this phone holds and has not seen settled. */
  unsettled?: Unsettled
  /** The last run, if one ran. */
  report?: SettlementReport
  /** True while notes wait for the person to read what settling in the clear publishes. */
  labelPending: boolean
  acknowledge: () => Promise<void>
  /** Settles what can be settled now: when a note was received, the app opened, or the connection came back. */
  run: () => Promise<void>
}

const SettlementContext = createContext<Settlement | undefined>(undefined)

/** Settles the notes this phone received to its own wallet, whenever the app is open and online. */
export function SettlementProvider({ children }: { children: ReactNode }) {
  const { db, domains } = usePayments()
  const { deviceKey, device } = useDeviceIdentity()
  const [unsettled, setUnsettled] = useState<Unsettled>()
  const [report, setReport] = useState<SettlementReport>()
  const [labelPending, setLabelPending] = useState(false)
  const attempts = useRef(new Map<string, number>())
  const running = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const key = deviceKey?.publicKey
  const wallet = device?.wallet

  const run = useCallback(async () => {
    if (!db) return
    setUnsettled(await unsettledSummary(db))
    if (!key || !wallet || !BUILD_GATEWAY || running.current) return
    running.current = true
    clearTimeout(timer.current)
    try {
      const result = await settleHeld({
        db,
        wallet: Uint8Array.from(getAddressEncoder().encode(wallet)),
        me: key,
        noteDomain: domains.noteDomain,
        program: domains.program,
        signSpend,
        gateway: BUILD_GATEWAY,
        now: nowSeconds,
        salt: () => crypto.getRandomValues(new Uint8Array(16)),
        labelAcknowledged: isLabelAcknowledged,
        random: Math.random,
        attempts: attempts.current,
      })
      setReport(result)
      setLabelPending(result.blocked === 'label')
      setUnsettled(await unsettledSummary(db))
      if (result.retryIn !== undefined) timer.current = setTimeout(() => void run(), result.retryIn * 1000)
    } finally {
      running.current = false
    }
  }, [db, domains, key, wallet])

  useEffect(() => {
    void run()
    const state = AppState.addEventListener('change', (status) => status === 'active' && void run())
    const network = addNetworkStateListener(({ isConnected }) => {
      if (isConnected) {
        attempts.current.clear()
        void run()
      }
    })
    return () => {
      state.remove()
      network.remove()
      clearTimeout(timer.current)
    }
  }, [run])

  const acknowledge = useCallback(async () => {
    await acknowledgeLabel()
    setLabelPending(false)
    await run()
  }, [run])

  const value = useMemo<Settlement>(
    () => ({ unsettled, report, labelPending, acknowledge, run }),
    [unsettled, report, labelPending, acknowledge, run],
  )
  return <SettlementContext.Provider value={value}>{children}</SettlementContext.Provider>
}

export function useSettlementRunner(): Settlement {
  const settlement = useContext(SettlementContext)
  if (!settlement) throw new Error('useSettlementRunner needs a SettlementProvider')
  return settlement
}
