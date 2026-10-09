import { address, createSolanaRpc } from '@solana/kit'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { deviceKeyCluster, signWitnessRecord } from '../../keys'
import { paymentDomains } from '../../payment/domains'
import { ACTIVE_PROFILE } from '../../protocol/active-profile'
import { type Attester, attesterFresh } from '../../protocol'
import { formatError } from '../../utils/format-error'
import { loadRegistry, parseTrusted, saveRegistry } from '../attesters/registry-cache'
import { readRegistryEntry } from '../attesters/registry-read'
import { syncRegistry, syncUntilUsable, withTimeout } from '../attesters/registry-sync'
import { useDeviceIdentity } from '../identity/use-device-identity'
import type { NoteDb } from '../notes/db'
import { openNoteDb } from '../notes/key'
import { reconcileIdentity } from '../notes/ledger'
import { createWitnessStore } from '../notes/witness-store'
import { createAppWitnessPort } from '../witness/app-port'
import { createModem } from '../witness/native'
import type { WitnessSettings } from '../witness/policy'
import type { WitnessPort } from '../witness/port'
import { DEFAULT_WITNESS_SETTINGS, loadWitnessSettings, saveWitnessSettings } from '../witness/settings-store'
import type { PaymentDomains } from './receiver'

const PROGRAM_ADDRESS = address(ACTIVE_PROFILE.programId)
const TRUSTED = parseTrusted(process.env.EXPO_PUBLIC_ATTESTERS)
const SECOND_RPC = process.env.EXPO_PUBLIC_SECOND_RPC_URL
const REGISTRY_READ_TIMEOUT_MS = 10_000
const REGISTRY_RETRY_DELAYS_MS = [3_000, 6_000, 12_000, 24_000, 48_000]

export type Payments = {
  /** The note store, once it is open and has been reconciled with the device key. */
  db?: NoteDb
  error?: string
  domains: PaymentDomains
  /** The attesters this wallet believes, as of the last sync, without what it relies on each. */
  attesters: readonly Attester[]
  /** Whether the build pins an attester at all. */
  hasTrustedAttesters: boolean
  syncAttesters: () => Promise<void>
  /** The nearby check settings of this phone. */
  witnessSettings: WitnessSettings
  setWitnessSettings: (patch: Partial<WitnessSettings>) => void
  /** The nearby check of payments, once the note store is open. */
  witnessPort?: WitnessPort
}

const PaymentsContext = createContext<Payments | undefined>(undefined)

export const nowSeconds = () => Math.floor(Date.now() / 1000)

/**
 * Opens the encrypted note store, marks what a key that is gone had received, and keeps the attester
 * registry as of the last time two providers agreed on it.
 */
export function PaymentsProvider({ children }: { children: ReactNode }) {
  const { client } = useMobileWallet()
  const { deviceKey, step, error: identityError } = useDeviceIdentity()
  const [opened, setOpened] = useState<NoteDb>()
  const [db, setDb] = useState<NoteDb>()
  const [error, setError] = useState<string>()
  const [attesters, setAttesters] = useState<readonly Attester[]>([])
  const attestersRef = useRef(attesters)
  const syncing = useRef(false)
  const cacheLoaded = useRef<Promise<void>>(Promise.resolve())
  const [witnessSettings, setSettings] = useState(DEFAULT_WITNESS_SETTINGS)
  const settingsRef = useRef(witnessSettings)
  const key = deviceKey?.publicKey

  const domains = useMemo(() => {
    const cluster = deviceKeyCluster()
    if (!cluster) throw new Error('configureDeviceKey must be called first')
    return paymentDomains(cluster)
  }, [])

  useEffect(() => {
    openNoteDb().then(setOpened, (failure: unknown) =>
      setError(`Couldn’t open the payments store. ${formatError(failure)}`),
    )
    cacheLoaded.current = loadRegistry().then((loaded) => {
      attestersRef.current = loaded
      setAttesters(loaded)
    })
  }, [])

  useEffect(() => {
    if (!opened || step === 'loading' || identityError) return
    let current = true
    reconcileIdentity(opened, key ?? new Uint8Array(0), nowSeconds()).then(
      () => current && setDb(opened),
      (failure: unknown) => current && setError(`Couldn’t read the payments store. ${formatError(failure)}`),
    )
    return () => {
      current = false
    }
  }, [opened, step, identityError, key])

  useEffect(() => {
    void loadWitnessSettings().then((loaded) => {
      settingsRef.current = loaded
      setSettings(loaded)
    })
  }, [])

  const setWitnessSettings = useCallback((patch: Partial<WitnessSettings>) => {
    const next = { ...settingsRef.current, ...patch }
    settingsRef.current = next
    setSettings(next)
    void saveWitnessSettings(next)
  }, [])

  const [witnessPort, setWitnessPort] = useState<WitnessPort>()
  useEffect(() => {
    if (!db) return
    setWitnessPort(
      createAppWitnessPort(createWitnessStore(db), () => settingsRef.current, {
        modem: createModem,
        sign: signWitnessRecord,
        witnessDomain: domains.witnessDomain,
      }),
    )
  }, [db, domains.witnessDomain])

  const syncAttesters = useCallback(async () => {
    if (TRUSTED.length === 0 || syncing.current) return
    syncing.current = true
    try {
      await cacheLoaded.current
      const readers = [client.rpc, ...(SECOND_RPC ? [createSolanaRpc(SECOND_RPC)] : [])].map((rpc) =>
        withTimeout((id: number) => readRegistryEntry(rpc, PROGRAM_ADDRESS, id), REGISTRY_READ_TIMEOUT_MS),
      )
      const believed = await syncRegistry({
        trusted: TRUSTED,
        readers,
        now: nowSeconds(),
        previous: attestersRef.current,
      })
      attestersRef.current = believed
      setAttesters(believed)
      await saveRegistry(believed)
    } finally {
      syncing.current = false
    }
  }, [client.rpc])

  useEffect(() => {
    if (TRUSTED.length === 0) return
    let current = true
    let looping = false
    const usable = () =>
      attestersRef.current.some((attester) => attester.active && attesterFresh(attester, nowSeconds()))
    const keepSyncing = async () => {
      if (looping) return
      looping = true
      try {
        await syncUntilUsable({
          sync: syncAttesters,
          usable,
          delays: REGISTRY_RETRY_DELAYS_MS,
          wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          stopped: () => !current,
          onError: (error) =>
            console.warn(`registry sync failed: ${error instanceof Error ? error.message : typeof error}`),
        })
      } finally {
        looping = false
      }
    }
    void keepSyncing()
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') void keepSyncing()
    })
    return () => {
      current = false
      subscription.remove()
    }
  }, [syncAttesters])

  const value = useMemo<Payments>(
    () => ({
      db,
      error,
      domains,
      attesters,
      hasTrustedAttesters: TRUSTED.length > 0,
      syncAttesters,
      witnessSettings,
      setWitnessSettings,
      witnessPort,
    }),
    [db, error, domains, attesters, syncAttesters, witnessSettings, setWitnessSettings, witnessPort],
  )
  return <PaymentsContext.Provider value={value}>{children}</PaymentsContext.Provider>
}

export function usePayments(): Payments {
  const payments = useContext(PaymentsContext)
  if (!payments) throw new Error('usePayments needs a PaymentsProvider')
  return payments
}
