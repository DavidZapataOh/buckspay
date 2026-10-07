import { bytesToHex } from '@noble/hashes/utils.js'
import { address, getAddressEncoder } from '@solana/kit'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { addNetworkStateListener } from 'expo-network'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { deviceKeyCluster, signSpend } from '../../keys'
import { ACTIVE_PROFILE } from '../../protocol/active-profile'
import { genesisHashOf } from '../../payment/domains'
import { relayQueue } from '../relay/queue'
import { registerSettler } from '../mesh/settle-flagged'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { BUILD_GATEWAY } from '../lock/gateway'
import { unsettledSummary, type Unsettled } from '../notes/ledger'
import { nowSeconds, usePayments } from '../payment/payments-provider'
import { isNoticeShown, markNoticeShown } from './clear-notice'
import { acknowledgeLabel, isLabelAcknowledged } from './label'
import { createDevicePrivateRoute } from '../zk/device'
import { type PendingNotice, settleHeld, type SettlementReport } from './settle-held'

export type Settlement = {
  /** What this phone holds and has not seen settled. */
  unsettled?: Unsettled
  /** The last run, if one ran. */
  report?: SettlementReport
  /** True while notes wait for the person to read what settling in the clear publishes. */
  labelPending: boolean
  acknowledge: () => Promise<void>
  /** Notes that wait for the person to read who settling them publishes. */
  notices: PendingNotice[]
  /** The person read the notice of this note and said to settle it. */
  confirmNotice: (outputId: Uint8Array) => Promise<void>
  /** The person asked to settle this note now: proofs start at once, on any network, and submission is not delayed. */
  settleNow: (outputId: Uint8Array) => Promise<void>
  /** True while a run is under way. */
  running: boolean
  /** Settles what can be settled now: when a note was received, the app opened, or the connection came back. */
  run: () => Promise<void>
}

const NO_NOTICES: PendingNotice[] = []
const EMPTY_REPORT: SettlementReport = {
  settled: 0,
  waiting: 0,
  failed: 0,
  refused: [],
  stalled: [],
  lost: [],
  notices: [],
  private: [],
}
const PROGRAM_ADDRESS = address(ACTIVE_PROFILE.programId)

const SettlementContext = createContext<Settlement | undefined>(undefined)

/** Settles the notes this phone received to its own wallet, whenever the app is open and online. */
export function SettlementProvider({ children }: { children: ReactNode }) {
  const { db, domains } = usePayments()
  const { deviceKey, device } = useDeviceIdentity()
  const { client } = useMobileWallet()
  const asked = useRef(new Set<string>())
  const [unsettled, setUnsettled] = useState<Unsettled>()
  const [report, setReport] = useState<SettlementReport>()
  const [labelPending, setLabelPending] = useState(false)
  const attempts = useRef(new Map<string, number>())
  const running = useRef(false)
  const again = useRef(false)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const key = deviceKey?.publicKey
  const wallet = device?.wallet

  const run = useCallback(async () => {
    if (!db) return
    setUnsettled(await unsettledSummary(db))
    if (running.current) {
      again.current = true
      return
    }
    if (!key || !wallet || !BUILD_GATEWAY) {
      setReport({ ...EMPTY_REPORT, blocked: !key || !wallet ? 'wallet' : 'gateway' })
      return
    }
    running.current = true
    setBusy(true)
    clearTimeout(timer.current)
    try {
      const cluster = deviceKeyCluster()
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
        noticeShown: isNoticeShown,
        random: Math.random,
        attempts: attempts.current,
        queueRelay: cluster ? relayQueue(db, genesisHashOf(cluster), nowSeconds) : undefined,
        private: createDevicePrivateRoute({
          db,
          gateway: BUILD_GATEWAY,
          rpc: client.rpc,
          programAddress: PROGRAM_ADDRESS,
          noteDomain: domains.noteDomain,
          now: nowSeconds,
          asked: asked.current,
        }),
      })
      setReport(result)
      setLabelPending(result.blocked === 'label')
      setUnsettled(await unsettledSummary(db))
      if (result.retryIn !== undefined) timer.current = setTimeout(() => void run(), result.retryIn * 1000)
    } finally {
      running.current = false
      setBusy(false)
      if (again.current) {
        again.current = false
        void run()
      }
    }
  }, [client.rpc, db, domains, key, wallet])

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

  useEffect(() => registerSettler(run), [run])

  const acknowledge = useCallback(async () => {
    await acknowledgeLabel()
    setLabelPending(false)
    await run()
  }, [run])

  const confirmNotice = useCallback(
    async (outputId: Uint8Array) => {
      await markNoticeShown(bytesToHex(outputId))
      await run()
    },
    [run],
  )

  const settleNow = useCallback(
    async (outputId: Uint8Array) => {
      asked.current.add(bytesToHex(outputId))
      await run()
    },
    [run],
  )

  const notices = report?.notices ?? NO_NOTICES
  const value = useMemo<Settlement>(
    () => ({ unsettled, report, labelPending, acknowledge, notices, confirmNotice, settleNow, running: busy, run }),
    [unsettled, report, labelPending, busy, acknowledge, notices, confirmNotice, settleNow, run],
  )
  return <SettlementContext.Provider value={value}>{children}</SettlementContext.Provider>
}

export function useSettlementRunner(): Settlement {
  const settlement = useContext(SettlementContext)
  if (!settlement) throw new Error('useSettlementRunner needs a SettlementProvider')
  return settlement
}
