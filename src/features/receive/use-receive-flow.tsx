import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { address } from '@solana/kit'
import { useMobileWallet } from '@wallet-ui/react-native-kit'
import type { PaymentRequest } from '../../payment/messages'
import { buildRequest } from '../../payment/request'
import { PaymentError } from '../../payment/messages'
import type { ReceiveContext } from '../../payment/receive'
import { receivePayment, showRequest } from '../../payment/receive-flow'
import { attesterFresh } from '../../protocol'
import { ACTIVE_PROFILE } from '../../protocol/active-profile'
import { type Transport, TransportError, type TransportId } from '../../transport/types'
import { parseAmount } from '../../utils/format-amount'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { copy } from '../payment/copy'
import { nowSeconds, usePayments } from '../payment/payments-provider'
import { entriesSince } from '../event/consumed'
import { pointReceiverOf } from '../event/point'
import { usePointMode } from '../event/use-point-mode'
import { receiverOf } from '../payment/receiver'
import { useQrSession } from '../payment/use-qr-session'
import type { Band } from '../witness/app-port'
import { requestWitness } from '../witness/request-witness'
import { type WitnessPolicy, witnessPolicy } from '../witness/policy'
import type { WitnessPort } from '../witness/port'
import { nearbyEntry, nfcEntry, qrEntry } from '../transport/registry'
import { createTransportSlot } from '../transport/slot'
import { untilExpiry } from '../transport/wait-budget'
import { useTransportChoice, useTransports } from '../transport/use-transports'
import { MIN_WINDOW, PAY_LIMITS } from '../pay/limits'
import { BUILD_MINT_BYTES, BUILD_TOKEN } from '../pay/tokens'
import { recordFeeSource } from '../zk/fee-gate'
import { receiveGate } from './receive-gate'
import { initialReceiveState, receiveReducer, type ReceiveState } from './receive-reducer'

const PROGRAM_ADDRESS = address(ACTIVE_PROFILE.programId)

export type CreateFailure = 'connect' | 'amount' | 'busy' | 'transport'

export type ReceiveFlow = {
  state: ReceiveState
  texts: ReturnType<typeof useQrSession>['texts']
  progress: ReturnType<typeof useQrSession>['progress']
  /** Whether the other phone's last code was not a payment: the screen says so. */
  wrongCode: boolean
  /** Why a request cannot be made now, in words; empty when it can. */
  blocked: string
  /**
   * Makes the request once its medium is open; `undefined` when it was made, else what is wrong.
   * `busy` means a request is already being made or shown.
   */
  create: (amountText: string, memo: string, passOn: boolean) => Promise<CreateFailure | undefined>
  scanPayment: () => void
  submitText: (text: string) => void
  cancel: () => void
  back: () => void
  expire: () => void
  finish: () => void
  /** The media this phone can receive on, and the one chosen. */
  how: Pick<ReturnType<typeof useTransports>, 'offered' | 'refresh'> & {
    chosen: TransportId
    choose: (id: TransportId) => void
  }
  /** The nearby check of the payment on screen, or undefined when the request did not ask for one. */
  witness: () => { policy: WitnessPolicy; band: Band; port: WitnessPort } | undefined
}

const ReceiveFlowContext = createContext<ReceiveFlow | undefined>(undefined)

/** Drives the receiver's screens: the request it shows, the payment it scans, what it did with it. */
export function ReceiveFlowProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(receiveReducer, initialReceiveState)
  const stateRef = useRef<ReceiveState>(state)
  useEffect(() => {
    stateRef.current = state
  })
  const [wrongCode, setWrongCode] = useState(false)
  const { db, domains, attesters, hasTrustedAttesters, witnessSettings, witnessPort } = usePayments()
  const { client } = useMobileWallet()
  const recordFees = useMemo(() => recordFeeSource(client.rpc, PROGRAM_ADDRESS), [client.rpc])
  const { deviceKey } = useDeviceIdentity()
  const session = useQrSession()
  const entries = useMemo(() => [qrEntry({ transport: session.transport }), nfcEntry, nearbyEntry], [session.transport])
  const { offered, ready, refresh } = useTransports(entries)
  const { chosen, choose } = useTransportChoice('receiver', ready)
  const medium = chosen ?? entries[0]
  const [slot] = useState(createTransportSlot)
  const transport = useRef<Transport>(session.transport)
  const used = useRef<TransportId>('qr')
  const asked = useRef<{ policy: WitnessPolicy; band: Band }>(undefined)
  const scanAfterRequest = useRef<() => void>(undefined)
  const { mode: point } = usePointMode()
  const pending = useRef<AbortController>(undefined)
  const creating = useRef(false)
  const key = deviceKey?.publicKey

  const usable = useMemo(
    () => attesters.filter((attester) => attester.active && attesterFresh(attester, nowSeconds())),
    [attesters],
  )
  const blocked = usable.length === 0 ? copy.receive.connectOnce : ''

  const abort = useCallback(() => {
    pending.current?.abort()
    pending.current = undefined
  }, [])

  const create = useCallback(
    async (amountText: string, memo: string, passOn: boolean): Promise<CreateFailure | undefined> => {
      if (!key || usable.length === 0) return 'connect'
      if (creating.current || stateRef.current.name !== 'composing') return 'busy'
      const amount = parseAmount(amountText, BUILD_TOKEN.decimals)
      if (amount === undefined || amount <= 0n) return 'amount'
      let request: PaymentRequest
      try {
        request = buildRequest({
          amount,
          memo,
          owner: point ? { type: 'account', address: point.pairing.authority } : { type: 'device', key },
          mint: BUILD_MINT_BYTES,
          attesters: usable.map((attester) => attester.id).slice(0, 8),
          now: nowSeconds(),
          minHops: passOn ? 2 : 1,
          witness: requestWitness(medium.id, amount, witnessSettings),
          limits: { maxPayment: PAY_LIMITS.maxPayment, minWindow: MIN_WINDOW },
        })
      } catch (error) {
        if (error instanceof PaymentError) return 'amount'
        throw error
      }
      const policy = witnessPolicy({ role: 'receiver', transport: medium.id, amount, settings: witnessSettings })
      asked.current = request.witness === 'none' ? undefined : { policy, band: request.witness }
      used.current = medium.id
      creating.current = true
      try {
        const opened = await slot.open(medium, 'receiver')
        transport.current = opened
        dispatch({ type: 'create', request, expiresAt: request.now + PAY_LIMITS.requestTtl })
        void showRequest(request, opened).then(() => {
          if (used.current !== 'qr' && stateRef.current.name === 'requesting') scanAfterRequest.current?.()
        })
        return undefined
      } catch {
        return 'transport'
      } finally {
        creating.current = false
      }
    },
    [key, medium, point, slot, usable, witnessSettings],
  )

  /** The payer's link dropped before a payment arrived: open the session again for the same request while it lives. */
  const advertiseAgain = useCallback(
    async (request: PaymentRequest) => {
      try {
        const opened = await slot.open(medium, 'receiver')
        if (stateRef.current.name !== 'requesting') return void slot.close()
        transport.current = opened
        void showRequest(request, opened).then(() => {
          if (stateRef.current.name === 'requesting') scanAfterRequest.current?.()
        })
      } catch {
        // The request stays up until it expires, and the person can cancel it and start again.
      }
    },
    [medium, slot],
  )

  const scanPayment = useCallback(() => {
    const current = stateRef.current
    if (current.name !== 'requesting' && current.name !== 'rejected') return
    const { request } = current
    dispatch({ type: 'scan-payment' })
    setWrongCode(false)
    abort()
    const controller = new AbortController()
    pending.current = controller
    const startedAt = nowSeconds()
    const context = async (): Promise<ReceiveContext> => {
      dispatch({ type: 'payment' })
      const now = nowSeconds()
      if (!db || !key) throw new Error('The payments store is not open')
      return {
        receiver: point
          ? await pointReceiverOf(db, domains, point.pairing, attesters, now)
          : await receiverOf(db, domains, key, attesters, now),
        db,
        limits: { maxPayment: PAY_LIMITS.maxPayment },
        transport: used.current,
        request: { amount: request.amount, memo: request.memo },
        gate: receiveGate(db, point, domains.noteDomain, { fee: recordFees, expected: request.amount }),
      }
    }
    void receivePayment(context, transport.current, {
      signal: controller.signal,
      timeoutMs: untilExpiry(used.current, current.expiresAt),
      onWrongCode: () => setWrongCode(true),
    }).then(
      (outcome) => {
        dispatch({ type: 'outcome', outcome })
        if (point && db && outcome.accepted) {
          void entriesSince(db, point.pairing.eventId, startedAt - 1).then((entries) => point.sync.push(entries))
        }
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        dispatch({ type: 'back' })
        const lost = error instanceof TransportError && (error.code === 'Interrupted' || error.code === 'Unavailable')
        if (lost && used.current === 'nearby' && nowSeconds() < current.expiresAt) void advertiseAgain(request)
      },
    )
  }, [abort, advertiseAgain, attesters, db, domains, key, point, recordFees])

  useEffect(() => {
    scanAfterRequest.current = scanPayment
  }, [scanPayment])

  const submitText = useCallback((text: string) => session.push(text), [session])

  const cancel = useCallback(() => {
    abort()
    session.clear()
    void slot.close()
    dispatch({ type: 'cancel' })
  }, [abort, session, slot])

  const back = useCallback(() => {
    const current = stateRef.current
    if (current.name !== 'scanning') return
    abort()
    dispatch({ type: 'back' })
    void showRequest(current.request, transport.current)
  }, [abort])

  const expire = useCallback(() => {
    session.clear()
    void slot.close()
    dispatch({ type: 'expire' })
  }, [session, slot])

  const finish = useCallback(() => {
    abort()
    session.clear()
    void slot.close()
    dispatch({ type: 'finish' })
  }, [abort, session, slot])

  useEffect(() => abort, [abort])
  useEffect(() => () => void slot.close(), [slot])

  const value = useMemo<ReceiveFlow>(
    () => ({
      state,
      texts: session.texts,
      progress: session.progress,
      wrongCode,
      blocked: hasTrustedAttesters ? blocked : copy.receive.connectOnce,
      create,
      scanPayment,
      submitText,
      cancel,
      back,
      expire,
      finish,
      how: { offered, refresh, chosen: medium.id, choose },
      witness: () => (asked.current && witnessPort ? { ...asked.current, port: witnessPort } : undefined),
    }),
    [
      state,
      session.texts,
      session.progress,
      wrongCode,
      hasTrustedAttesters,
      blocked,
      create,
      scanPayment,
      submitText,
      cancel,
      back,
      expire,
      finish,
      offered,
      refresh,
      medium.id,
      choose,
      witnessPort,
    ],
  )
  return <ReceiveFlowContext.Provider value={value}>{children}</ReceiveFlowContext.Provider>
}

export function useReceiveFlow(): ReceiveFlow {
  const flow = useContext(ReceiveFlowContext)
  if (!flow) throw new Error('useReceiveFlow needs a ReceiveFlowProvider')
  return flow
}
