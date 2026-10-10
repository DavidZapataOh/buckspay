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
import { equalBytes } from '@noble/curves/utils.js'
import { authenticate } from '../../payment/authenticate'
import { signStoredIssue } from '../../payment/native-sign'
import { signSpend } from '../../keys'
import {
  awaitReceipt,
  confirmAndSend,
  confirmAndSendRespend,
  PayError,
  type PayDeps,
  resumeForRequest,
  resumePayments,
} from '../../payment/pay'
import { type PayContext, planPayment } from '../../payment/preflight'
import { planRespend } from '../../payment/respend'
import { withoutFlagged } from '../mesh/gossip'
import { awaitRequest } from '../../payment/scan'
import { MessageKind, type Transport, TransportError, type TransportId } from '../../transport/types'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { useOfflineLocks } from '../attesters/use-offline-locks'
import { listEvents, type StoredEvent } from '../event/store'
import { type Unfinished, heldOutputs, paymentContext, setOutgoingState, unfinishedPayments } from '../notes/outgoing'
import { copy, text } from '../payment/copy'
import { nowSeconds, usePayments } from '../payment/payments-provider'
import { useQrSession } from '../payment/use-qr-session'
import type { Band } from '../witness/app-port'
import type { WitnessPolicy } from '../witness/policy'
import type { WitnessPort } from '../witness/port'
import { payerAnswer } from '../witness/request-witness'
import { nearbyEntry, nfcEntry, qrEntry } from '../transport/registry'
import { createTransportSlot } from '../transport/slot'
import { receiptBudget, waitBudget } from '../transport/wait-budget'
import { useTransportChoice, useTransports } from '../transport/use-transports'
import { formatMoney } from '../../utils/format-amount'
import { PAY_LIMITS } from './limits'
import { initialPayState, payReducer, type PayState, type ScanStep } from './pay-reducer'
import { BUILD_TOKEN, BUILD_TOKENS } from './tokens'

type Offline = ReturnType<typeof useOfflineLocks>

export type PayFlow = {
  state: PayState
  /** The name of the state right now, for a cleanup that must not read a stale one. */
  stateName: () => PayState['name']
  texts: ReturnType<typeof useQrSession>['texts']
  progress: ReturnType<typeof useQrSession>['progress']
  offline: Offline
  /** The events this phone runs that have not ended: the credit it can sell. */
  events: readonly StoredEvent[]
  /** The event whose credit the next payment sells, or null for an ordinary payment. */
  creditEvent: StoredEvent | null
  setCreditEvent: (event: StoredEvent | null) => void
  reloadEvents: () => Promise<void>
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
  /** The media this phone can pay on, and the one chosen. */
  how: Pick<ReturnType<typeof useTransports>, 'offered' | 'refresh'> & {
    chosen: TransportId
    choose: (id: TransportId) => void
  }
  /** The nearby check of the payment sent, or undefined when the receiver did not ask for one. */
  witness: () => { policy: WitnessPolicy; band: Band; port: WitnessPort } | undefined
}

const PayFlowContext = createContext<PayFlow | undefined>(undefined)

const startOfToday = () => Math.floor(new Date().setHours(0, 0, 0, 0) / 1000)

/** Drives the payer's screens: scanning a request, confirming, showing the payment, reading the receipt. */
export function PayFlowProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(payReducer, initialPayState)
  const stateRef = useRef<PayState>(state)
  const { db, domains, witnessSettings, witnessPort } = usePayments()
  const { deviceKey } = useDeviceIdentity()
  const offline = useOfflineLocks()
  const session = useQrSession()
  const entries = useMemo(() => [qrEntry({ transport: session.transport }), nfcEntry, nearbyEntry], [session.transport])
  const { offered, ready, refresh } = useTransports(entries)
  const { chosen, choose } = useTransportChoice('payer', ready)
  const medium = chosen ?? entries[0]
  const [slot] = useState(createTransportSlot)
  const transport = useRef<Transport>(session.transport)
  const used = useRef<TransportId>('qr')
  const answer = useRef<{ policy: WitnessPolicy; band: Band }>(undefined)
  const [unfinished, setUnfinished] = useState<readonly Unfinished[]>([])
  const [events, setEvents] = useState<readonly StoredEvent[]>([])
  const [creditEvent, setCreditEvent] = useState<StoredEvent | null>(null)
  const pending = useRef<AbortController>(undefined)
  /** Set by Resume of a payment made over Nearby: the next scan finishes it if the receiver is the same one. */
  const finishLeft = useRef(false)
  const key = deviceKey?.publicKey
  const latest = useRef({ offline, db, key, creditEvent })
  useEffect(() => {
    stateRef.current = state
    latest.current = { offline, db, key, creditEvent }
  })

  const reloadEvents = useCallback(async () => {
    if (!db) return
    const running = await listEvents(db, 'organiser')
    setEvents(running.filter((event) => event.endsAt > nowSeconds()))
  }, [db])
  useEffect(() => {
    if (!db) return
    let current = true
    void listEvents(db, 'organiser').then(
      (running) => current && setEvents(running.filter((event) => event.endsAt > nowSeconds())),
    )
    return () => {
      current = false
    }
  }, [db])

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
        signSpend,
        transport: transport.current,
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
    [db, domains.noteDomain],
  )

  const abort = useCallback(() => {
    pending.current?.abort()
    pending.current = undefined
  }, [])

  const scan = useCallback(() => {
    const { name } = stateRef.current
    if (name !== 'idle') {
      if (name !== 'presenting' && name !== 'confirmed' && name !== 'rejected' && name !== 'failed') return
      session.clear()
      dispatch({ type: 'finish' })
    }
    dispatch({ type: 'scan' })
    abort()
    const finishing = finishLeft.current
    finishLeft.current = false
    const controller = new AbortController()
    pending.current = controller
    void (async () => {
      let step: ScanStep = 'E_READ'
      try {
        const opened = await slot.open(medium, 'payer').catch(() => undefined)
        if (!opened) return controller.signal.aborted ? undefined : dispatch({ type: 'back' })
        transport.current = opened
        used.current = medium.id
        const request = await awaitRequest(opened, {
          signal: controller.signal,
          timeoutMs: waitBudget(medium.id),
          onWrongCode: () => dispatch({ type: 'wrong-code' }),
        })
        const { offline: current, db: store, key, creditEvent: credit } = latest.current
        if (!store || !key) return
        step = 'E_STORE'
        const finished = finishing && (await resumeForRequest(depsFor(), request))
        if (finished) return dispatch({ type: 'resumed', payment: finished })
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
        step = 'E_PLAN'
        const respent = credit
          ? null
          : planRespend(request, await withoutFlagged(store, await heldOutputs(store, key, context.now)), context)
        dispatch({
          type: 'planned',
          request,
          planned: respent?.ok
            ? respent
            : planPayment(request, context, credit ? { authorityOnly: credit.authority } : undefined),
        })
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof TransportError && error.code === 'Timeout') return dispatch({ type: 'timed-out' })
        console.warn(`scan failed at ${step}: ${error instanceof Error ? error.name : typeof error}`)
        dispatch({ type: 'unreadable', step })
      }
    })()
  }, [abort, depsFor, domains, medium, session, slot])

  const submitText = useCallback((value: string) => session.push(value), [session])

  const confirm = useCallback(async () => {
    const current = stateRef.current
    if (current.name !== 'reviewing') return
    dispatch({ type: 'confirm' })
    abort()
    try {
      const { plan, request } = current
      const deps = depsFor(plan.review.receiverCode)
      const { policy, band } = payerAnswer(used.current, request, witnessSettings)
      answer.current = band ? { policy, band } : undefined
      const payment =
        'spend' in plan
          ? await confirmAndSendRespend(plan, request, used.current, { ...deps, signSpend })
          : await confirmAndSend(plan, request, used.current, deps)
      dispatch({ type: 'sent', payment })
    } catch (error) {
      dispatch({ type: 'failed', error: error instanceof PayError ? error : new PayError('SignFailed', error) })
    }
    await Promise.all([reloadUnfinished(), latest.current.offline.reload()])
  }, [abort, depsFor, reloadUnfinished, witnessSettings])

  const scanReceipt = useCallback(() => {
    const current = stateRef.current
    if (current.name !== 'presenting') return
    dispatch({ type: 'scan-receipt' })
    abort()
    const controller = new AbortController()
    pending.current = controller
    void awaitReceipt(current.payment, depsFor(), {
      signal: controller.signal,
      timeoutMs: receiptBudget(used.current),
    }).then(
      async (result) => {
        dispatch({ type: 'receipt', result })
        await reloadUnfinished()
      },
      (error) => {
        if (controller.signal.aborted) return
        dispatch(
          error instanceof TransportError && error.code === 'Timeout'
            ? { type: 'receipt-timed-out' }
            : { type: 'cancel' },
        )
      },
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
      abort()
      const current = stateRef.current
      if (
        (current.name === 'presenting' || current.name === 'awaiting-receipt') &&
        (!messageId || equalBytes(current.payment.messageId, messageId))
      ) {
        try {
          await transport.current.send({ kind: MessageKind.Payment, payload: current.payment.bundle })
          dispatch({ type: 'resumed', payment: current.payment })
        } catch (error) {
          dispatch({ type: 'failed', error: new PayError('SendFailed', error) })
        }
        return
      }
      const left = (db ? await unfinishedPayments(db) : []).find(
        (row) => !messageId || equalBytes(row.messageId, messageId),
      )
      if (left?.transport === 'nearby') {
        finishLeft.current = true
        return scan()
      }
      try {
        const [payment] = await resumePayments(depsFor(), messageId)
        if (payment) dispatch({ type: 'resumed', payment })
      } catch (error) {
        dispatch({ type: 'failed', error: error instanceof PayError ? error : new PayError('SignFailed', error) })
      }
      await reloadUnfinished()
    },
    [abort, db, depsFor, reloadUnfinished, scan],
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
    void slot.close()
    transport.current = session.transport
    dispatch({ type: 'back' })
  }, [abort, session, slot])

  const finish = useCallback(() => {
    abort()
    session.clear()
    void slot.close()
    transport.current = session.transport
    dispatch({ type: 'finish' })
    void reloadUnfinished()
    void latest.current.offline.reload()
  }, [abort, reloadUnfinished, session, slot])

  useEffect(() => abort, [abort])
  useEffect(() => () => void slot.close(), [slot])

  const value = useMemo<PayFlow>(
    () => ({
      state,
      stateName: () => stateRef.current.name,
      texts: session.texts,
      progress: session.progress,
      offline,
      events,
      creditEvent,
      setCreditEvent,
      reloadEvents,
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
      how: { offered, refresh, chosen: medium.id, choose },
      witness: () => (answer.current && witnessPort ? { ...answer.current, port: witnessPort } : undefined),
    }),
    [
      state,
      session.texts,
      session.progress,
      offline,
      events,
      creditEvent,
      reloadEvents,
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
      offered,
      refresh,
      medium.id,
      choose,
      witnessPort,
    ],
  )
  return <PayFlowContext.Provider value={value}>{children}</PayFlowContext.Provider>
}

export function usePayFlow(): PayFlow {
  const flow = useContext(PayFlowContext)
  if (!flow) throw new Error('usePayFlow needs a PayFlowProvider')
  return flow
}
