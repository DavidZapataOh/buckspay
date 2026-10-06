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
import { authenticate } from '../../payment/authenticate'
import { safetyCode } from '../../payment/messages'
import { signStoredIssue } from '../../payment/native-sign'
import { awaitReceipt, confirmAndSend, PayError, type PayDeps, resumePayments } from '../../payment/pay'
import { type PayContext, planPayment } from '../../payment/preflight'
import { awaitRequest } from '../../payment/scan'
import { MessageKind } from '../../transport/types'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { useOfflineLocks } from '../attesters/use-offline-locks'
import { type Unfinished, paymentContext, setOutgoingState, unfinishedPayments } from '../notes/outgoing'
import { copy, text } from '../payment/copy'
import { nowSeconds, usePayments } from '../payment/payments-provider'
import { useQrSession } from '../payment/use-qr-session'
import { formatMoney } from '../../utils/format-amount'
import { PAY_LIMITS } from './limits'
import { initialPayState, payReducer, type PayState } from './pay-reducer'
import { BUILD_TOKEN, BUILD_TOKENS } from './tokens'

type Offline = ReturnType<typeof useOfflineLocks>

export type PayFlow = {
  state: PayState
  /** The name of the state right now, for a cleanup that must not read a stale one. */
  stateName: () => PayState['name']
  texts: ReturnType<typeof useQrSession>['texts']
  progress: ReturnType<typeof useQrSession>['progress']
  offline: Offline
  /** The payments this phone started and did not finish. */
  unfinished: readonly Unfinished[]
  scan: () => void
  /** A text from the camera, a paste or an end-to-end harness. */
  submitText: (text: string) => void
  confirm: () => Promise<void>
  scanReceipt: () => void
  cancelReceipt: () => void
  showAgain: () => void
  /** Signs the stored issue again, or shows the stored bytes again, for one unfinished payment or the one on screen. */
  resume: (messageId?: Uint8Array) => Promise<void>
  discard: (messageId: Uint8Array) => Promise<void>
  back: () => void
  finish: () => void
}

const PayFlowContext = createContext<PayFlow | undefined>(undefined)

const startOfToday = () => Math.floor(new Date().setHours(0, 0, 0, 0) / 1000)

/** Drives the payer's screens: scanning a request, confirming, showing the payment, reading the receipt. */
export function PayFlowProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(payReducer, initialPayState)
  const stateRef = useRef<PayState>(state)
  const { db, domains } = usePayments()
  const { deviceKey } = useDeviceIdentity()
  const offline = useOfflineLocks()
  const session = useQrSession()
  const [unfinished, setUnfinished] = useState<readonly Unfinished[]>([])
  const pending = useRef<AbortController>(undefined)
  const key = deviceKey?.publicKey
  const latest = useRef({ offline, db, key })
  useEffect(() => {
    stateRef.current = state
    latest.current = { offline, db, key }
  })

  const reloadUnfinished = useCallback(async () => {
    if (db) setUnfinished(await unfinishedPayments(db))
  }, [db])
  useEffect(() => {
    if (!db) return
    let current = true
    void unfinishedPayments(db).then((rows) => current && setUnfinished(rows))
    return () => {
      current = false
    }
  }, [db])

  const depsFor = useCallback(
    (receiverCode?: string): PayDeps => {
      if (!db) throw new Error('The payments store is not open')
      return {
        db,
        sign: signStoredIssue,
        transport: session.transport,
        authenticate: (amount) =>
          authenticate(
            copy.review.promptTitle,
            text(copy.review.promptSubtitle, {
              amount: formatMoney(amount, BUILD_TOKEN.decimals),
              symbol: BUILD_TOKEN.symbol,
              code: receiverCode ?? '',
            }),
            copy.review.cancel,
          ),
        noteDomain: domains.noteDomain,
        now: nowSeconds,
      }
    },
    [db, domains.noteDomain, session.transport],
  )

  const abort = useCallback(() => {
    pending.current?.abort()
    pending.current = undefined
  }, [])

  const scan = useCallback(() => {
    if (stateRef.current.name !== 'idle') return
    dispatch({ type: 'scan' })
    abort()
    const controller = new AbortController()
    pending.current = controller
    void (async () => {
      try {
        const request = await awaitRequest(session.transport, {
          signal: controller.signal,
          onWrongCode: () => dispatch({ type: 'wrong-code' }),
        })
        const { offline: current, db: store, key } = latest.current
        if (!store || !key) return
        const context: PayContext = {
          now: nowSeconds(),
          me: key,
          noteDomain: domains.noteDomain,
          program: domains.program,
          locks: current.locks,
          tokens: BUILD_TOKENS,
          limits: PAY_LIMITS,
          salt: () => crypto.getRandomValues(new Uint8Array(16)),
          ...(await paymentContext(store, startOfToday())),
        }
        dispatch({ type: 'planned', request, planned: planPayment(request, context) })
      } catch {
        // The screen was left: nothing is waiting.
      }
    })()
  }, [abort, domains, session.transport])

  const submitText = useCallback((value: string) => session.push(value), [session])

  const confirm = useCallback(async () => {
    const current = stateRef.current
    if (current.name !== 'reviewing') return
    dispatch({ type: 'confirm' })
    abort()
    try {
      const code = safetyCode(current.plan.issue.owner)
      const payment = await confirmAndSend(current.plan, current.request, 'qr', depsFor(code))
      dispatch({ type: 'sent', payment })
    } catch (error) {
      dispatch({ type: 'failed', error: error instanceof PayError ? error : new PayError('SignFailed', error) })
    }
    await Promise.all([reloadUnfinished(), latest.current.offline.reload()])
  }, [abort, depsFor, reloadUnfinished])

  const scanReceipt = useCallback(() => {
    const current = stateRef.current
    if (current.name !== 'presenting') return
    dispatch({ type: 'scan-receipt' })
    abort()
    const controller = new AbortController()
    pending.current = controller
    void awaitReceipt(current.payment, depsFor(), { signal: controller.signal }).then(
      async (result) => {
        dispatch({ type: 'receipt', result })
        await reloadUnfinished()
      },
      () => undefined,
    )
  }, [abort, depsFor, reloadUnfinished])

  const cancelReceipt = useCallback(() => {
    abort()
    dispatch({ type: 'cancel' })
  }, [abort])

  const showAgain = useCallback(() => {
    const current = stateRef.current
    if (current.name !== 'rejected') return
    dispatch({ type: 'show-again' })
    void depsFor()
      .transport.send({ kind: MessageKind.Payment, payload: current.payment.bundle })
      .catch(() => undefined)
  }, [depsFor])

  const resume = useCallback(
    async (messageId?: Uint8Array) => {
      try {
        const [payment] = await resumePayments(depsFor(), messageId)
        if (payment) dispatch({ type: 'resumed', payment })
      } catch (error) {
        dispatch({ type: 'failed', error: error instanceof PayError ? error : new PayError('SignFailed', error) })
      }
      await reloadUnfinished()
    },
    [depsFor, reloadUnfinished],
  )

  const discard = useCallback(
    async (messageId: Uint8Array) => {
      if (db) await setOutgoingState(db, messageId, 'abandoned', nowSeconds())
      await reloadUnfinished()
    },
    [db, reloadUnfinished],
  )

  const back = useCallback(() => {
    abort()
    session.clear()
    dispatch({ type: 'back' })
  }, [abort, session])

  const finish = useCallback(() => {
    abort()
    session.clear()
    dispatch({ type: 'finish' })
    void reloadUnfinished()
    void latest.current.offline.reload()
  }, [abort, reloadUnfinished, session])

  useEffect(() => abort, [abort])

  const value = useMemo<PayFlow>(
    () => ({
      state,
      stateName: () => stateRef.current.name,
      texts: session.texts,
      progress: session.progress,
      offline,
      unfinished,
      scan,
      submitText,
      confirm,
      scanReceipt,
      cancelReceipt,
      showAgain,
      resume,
      discard,
      back,
      finish,
    }),
    [
      state,
      session.texts,
      session.progress,
      offline,
      unfinished,
      scan,
      submitText,
      confirm,
      scanReceipt,
      cancelReceipt,
      showAgain,
      resume,
      discard,
      back,
      finish,
    ],
  )
  return <PayFlowContext.Provider value={value}>{children}</PayFlowContext.Provider>
}

export function usePayFlow(): PayFlow {
  const flow = useContext(PayFlowContext)
  if (!flow) throw new Error('usePayFlow needs a PayFlowProvider')
  return flow
}
