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
import { buildRequest } from '../../payment/request'
import { PaymentError } from '../../payment/messages'
import type { ReceiveContext } from '../../payment/receive'
import { receivePayment, showRequest } from '../../payment/receive-flow'
import { attesterFresh } from '../../protocol'
import { parseAmount } from '../../utils/format-amount'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { copy } from '../payment/copy'
import { nowSeconds, usePayments } from '../payment/payments-provider'
import { entriesSince } from '../event/consumed'
import { pointGate, pointReceiverOf } from '../event/point'
import { usePointMode } from '../event/use-point-mode'
import { receiverOf } from '../payment/receiver'
import { useQrSession } from '../payment/use-qr-session'
import { MIN_WINDOW, PAY_LIMITS } from '../pay/limits'
import { BUILD_MINT_BYTES, BUILD_TOKEN } from '../pay/tokens'
import { initialReceiveState, receiveReducer, type ReceiveState } from './receive-reducer'

export type ReceiveFlow = {
  state: ReceiveState
  texts: ReturnType<typeof useQrSession>['texts']
  progress: ReturnType<typeof useQrSession>['progress']
  /** Whether the other phone's last code was not a payment: the screen says so. */
  wrongCode: boolean
  /** Why a request cannot be made now, in words; empty when it can. */
  blocked: string
  /** Makes the request and shows it; `undefined` when it was made, else what is wrong. */
  create: (amountText: string, memo: string, passOn: boolean) => 'connect' | 'amount' | undefined
  scanPayment: () => void
  submitText: (text: string) => void
  cancel: () => void
  back: () => void
  expire: () => void
  finish: () => void
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
  const { db, domains, attesters, hasTrustedAttesters } = usePayments()
  const { deviceKey } = useDeviceIdentity()
  const session = useQrSession()
  const { mode: point } = usePointMode()
  const pending = useRef<AbortController>(undefined)
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
    (amountText: string, memo: string, passOn: boolean) => {
      if (stateRef.current.name !== 'composing' || !key || usable.length === 0) return 'connect'
      const amount = parseAmount(amountText, BUILD_TOKEN.decimals)
      if (amount === undefined || amount <= 0n) return 'amount'
      try {
        const request = buildRequest({
          amount,
          memo,
          owner: point ? { type: 'account', address: point.pairing.authority } : { type: 'device', key },
          mint: BUILD_MINT_BYTES,
          attesters: usable.map((attester) => attester.id).slice(0, 8),
          now: nowSeconds(),
          minHops: passOn ? 2 : 1,
          limits: { maxPayment: PAY_LIMITS.maxPayment, minWindow: MIN_WINDOW },
        })
        void showRequest(request, session.transport)
        dispatch({ type: 'create', request, expiresAt: request.now + PAY_LIMITS.requestTtl })
      } catch (error) {
        if (error instanceof PaymentError) return 'amount'
        throw error
      }
      return undefined
    },
    [key, point, session.transport, usable],
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
        transport: 'qr',
        request: { amount: request.amount, memo: request.memo },
        gate: point ? pointGate(db, point.pairing, domains.noteDomain, nowSeconds) : undefined,
      }
    }
    void receivePayment(context, session.transport, {
      signal: controller.signal,
      onWrongCode: () => setWrongCode(true),
    }).then(
      (outcome) => {
        dispatch({ type: 'outcome', outcome })
        if (point && db && outcome.accepted) {
          void entriesSince(db, point.pairing.eventId, startedAt - 1).then((entries) => point.sync.push(entries))
        }
      },
      () => undefined,
    )
  }, [abort, attesters, db, domains, key, point, session.transport])

  const submitText = useCallback((text: string) => session.push(text), [session])

  const cancel = useCallback(() => {
    abort()
    session.clear()
    dispatch({ type: 'cancel' })
  }, [abort, session])

  const back = useCallback(() => {
    const current = stateRef.current
    if (current.name !== 'scanning') return
    abort()
    dispatch({ type: 'back' })
    void showRequest(current.request, session.transport)
  }, [abort, session.transport])

  const expire = useCallback(() => {
    session.clear()
    dispatch({ type: 'expire' })
  }, [session])

  const finish = useCallback(() => {
    abort()
    session.clear()
    dispatch({ type: 'finish' })
  }, [abort, session])

  useEffect(() => abort, [abort])

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
    ],
  )
  return <ReceiveFlowContext.Provider value={value}>{children}</ReceiveFlowContext.Provider>
}

export function useReceiveFlow(): ReceiveFlow {
  const flow = useContext(ReceiveFlowContext)
  if (!flow) throw new Error('useReceiveFlow needs a ReceiveFlowProvider')
  return flow
}
