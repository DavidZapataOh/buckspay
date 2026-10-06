import { useMobileWallet, type WalletAuthorizationCache } from '@wallet-ui/react-native-kit'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react'
import { AppState } from 'react-native'
import { address } from '@solana/kit'
import { ACTIVE_PROFILE } from '../../protocol/active-profile'
import { BUILD_FUNDING_MINT } from '../lock/build-funding'
import { BUILD_GATEWAY } from '../lock/gateway'
import type { BuildNetwork } from '../network/build-network'
import type { ActivationInput } from './activation'
import {
  advanceIdentity,
  describeIdentityError,
  forgetIdentity,
  type IdentityContext,
  type IdentityState,
  resolveIdentity,
} from './device-identity'

const PROGRAM_ADDRESS = address(ACTIVE_PROFILE.programId)

export type DeviceIdentity = IdentityState & {
  /** True while a step runs or the state is being derived. */
  busy: boolean
  /** Performs the current step; connecting goes on to create the key. `input` is what activating adds. */
  next: (input?: ActivationInput) => Promise<void>
  /** Forgets the wallet authorization on this phone; the device key and its registration stay. */
  disconnect: () => Promise<void>
  /** After the device key was deleted: forgets the records kept for it, so onboarding starts again at creating a key. */
  reset: () => Promise<void>
}

const DeviceIdentityContext = createContext<DeviceIdentity>({
  step: 'loading',
  busy: true,
  next: async () => {},
  disconnect: async () => {},
  reset: async () => {},
})

/**
 * Derives the device identity once, then after each of its own actions: the wallet authorization
 * changes only through `next` and `disconnect`. An activation that may still land is waited for
 * without a tap, a device account read from storage is checked against Solana in the background, and
 * coming back to the app retries what was waiting on Solana. `cache` is the one the
 * `MobileWalletProvider` uses.
 */
export function DeviceIdentityProvider({
  build: { cluster, network },
  cache,
  children,
}: {
  build: BuildNetwork
  cache: WalletAuthorizationCache
  children: ReactNode
}) {
  const { client, connect, disconnect, getTransactionSigner, signTransactions } = useMobileWallet()
  const [state, setState] = useState<IdentityState>({ step: 'loading' })
  const context = useMemo<IdentityContext>(
    () => ({
      cluster,
      chain: network.id,
      cache,
      rpc: client.rpc,
      connect,
      disconnect,
      getTransactionSigner,
      signTransactions,
      gateway: BUILD_GATEWAY,
      programAddress: PROGRAM_ADDRESS,
      windows: ACTIVE_PROFILE.windows,
      mint: BUILD_FUNDING_MINT,
      onProgress: setState,
    }),
    [cluster, network.id, cache, client.rpc, connect, disconnect, getTransactionSigner, signTransactions],
  )
  const [busy, setBusy] = useState(true)
  const running = useRef(false)

  const run = useCallback(
    async (step: (ctx: IdentityContext) => Promise<IdentityState>) => {
      if (running.current) return
      running.current = true
      setBusy(true)
      try {
        setState(await step(context))
      } catch (error) {
        setState((current) => ({ ...current, ...describeIdentityError(error, current.step) }))
      } finally {
        running.current = false
        setBusy(false)
      }
    },
    [context],
  )

  const next = useCallback(
    (input?: ActivationInput) =>
      run(async (ctx) => {
        const advanced = await advanceIdentity(ctx, state, input)
        // Connecting and creating the key are one step for the user.
        return state.step === 'connect' && advanced.step === 'create-key' && !advanced.error
          ? advanceIdentity(ctx, advanced)
          : advanced
      }),
    [run, state],
  )

  const derive = useEffectEvent(() =>
    run(async (ctx) => {
      const derived = await resolveIdentity(ctx)
      // A device account read from storage: Solana confirms it once it can be reached.
      if (derived.device) {
        void resolveIdentity(ctx, { refresh: true }).then(
          (checked) => checked.step !== 'unreachable' && !running.current && setState(checked),
          () => {},
        )
      }
      return derived
    }),
  )
  useEffect(() => {
    void derive()
  }, [])

  const confirmPending = useEffectEvent(() => {
    if (state.step === 'confirming' && !state.error && !running.current) void next()
  })
  useEffect(() => {
    confirmPending()
  }, [state.step, state.error, busy])

  const resume = useEffectEvent(() => {
    const stopped = state.step === 'unreachable' || (!!state.error && ['loading', 'confirming'].includes(state.step))
    if (stopped && !running.current) void next()
  })
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => status === 'active' && resume())
    return () => subscription.remove()
  }, [])

  const forget = useCallback(
    () =>
      run(async (ctx) => {
        await ctx.disconnect()
        return resolveIdentity(ctx)
      }),
    [run],
  )

  const reset = useCallback(() => run(forgetIdentity), [run])

  const value = useMemo(() => ({ ...state, busy, next, disconnect: forget, reset }), [state, busy, next, forget, reset])
  return <DeviceIdentityContext.Provider value={value}>{children}</DeviceIdentityContext.Provider>
}

export function useDeviceIdentity(): DeviceIdentity {
  return useContext(DeviceIdentityContext)
}
