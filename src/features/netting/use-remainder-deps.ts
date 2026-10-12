import { useEffect, useMemo, useRef } from 'react'
import { currentLanguage, i18n } from '../../i18n'
import { formatMoney } from '../../i18n/format'
import { signSpend } from '../../keys'
import { authenticate } from '../../payment/authenticate'
import { signStoredIssue } from '../../payment/native-sign'
import { buildRequest } from '../../payment/request'
import { attesterFresh } from '../../protocol'
import { useOfflineLocks } from '../attesters/use-offline-locks'
import { useDebts } from '../debts/use-debts'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { paymentContext } from '../notes/outgoing'
import { PAY_LIMITS, MIN_WINDOW } from '../pay/limits'
import { BUILD_MINT_BYTES, BUILD_TOKEN, BUILD_TOKENS } from '../pay/tokens'
import { nowSeconds, usePayments } from '../payment/payments-provider'
import { receiverOf } from '../payment/receiver'
import { receiveGate } from '../receive/receive-gate'
import type { SessionPort } from './session-port'
import { SessionLink } from './link'
import type { RemainderDeps } from './remainder'

const startOfToday = () => Math.floor(new Date().setHours(0, 0, 0, 0) / 1000)

/** Minutes, not seconds: the person has to press Pay and the other phone has to be waiting. */
const TIMEOUTS = { request: 300_000, repay: 300_000, payment: 120_000, receipt: 30_000 }

/** What the payment of a remainder needs from the app, assembled the way the pay and receive screens assemble it. */
export function useRemainderDeps(): ((session: Uint8Array, port: SessionPort) => RemainderDeps) | undefined {
  const debts = useDebts()
  const { db, domains, attesters } = usePayments()
  const { deviceKey } = useDeviceIdentity()
  const offline = useOfflineLocks()
  const key = deviceKey?.publicKey
  const latest = useRef({ locks: offline.locks, attesters })
  useEffect(() => {
    latest.current = { locks: offline.locks, attesters }
  })

  return useMemo(() => {
    if (!debts || !db || !key) return undefined
    return (session, port) => ({
      db,
      now: nowSeconds,
      mint: BUILD_MINT_BYTES,
      session,
      debts,
      link: (peer) => new SessionLink(port, peer),
      payContext: async () => ({
        now: nowSeconds(),
        me: key,
        noteDomain: domains.noteDomain,
        program: domains.program,
        locks: latest.current.locks,
        tokens: BUILD_TOKENS,
        limits: PAY_LIMITS,
        salt: () => crypto.getRandomValues(new Uint8Array(16)),
        ...(await paymentContext(db, startOfToday())),
      }),
      payDeps: () => ({
        db,
        sign: signStoredIssue,
        signSpend,
        authenticate: (amount) =>
          authenticate(
            i18n.t('payment:review.promptTitle'),
            i18n.t('payment:review.promptSubtitle', {
              amount: formatMoney(amount, BUILD_TOKEN.decimals, currentLanguage()),
              symbol: BUILD_TOKEN.symbol,
              code: '',
            }),
            i18n.t('payment:review.cancel'),
          ),
        noteDomain: domains.noteDomain,
        now: nowSeconds,
      }),
      receiveContext: async () => ({
        receiver: await receiverOf(db, domains, key, latest.current.attesters, nowSeconds()),
        db,
        limits: { maxPayment: PAY_LIMITS.maxPayment },
        transport: 'nearby',
        request: null,
        gate: receiveGate(db, null, domains.noteDomain),
      }),
      requestFor: (tab) =>
        buildRequest({
          amount: tab.remaining,
          memo: '',
          owner: { type: 'device', key },
          mint: BUILD_MINT_BYTES,
          attesters: latest.current.attesters
            .filter((attester) => attester.active && attesterFresh(attester, nowSeconds()))
            .map((attester) => attester.id)
            .slice(0, 8),
          now: nowSeconds(),
          limits: { maxPayment: PAY_LIMITS.maxPayment, minWindow: MIN_WINDOW },
        }),
      timeouts: TIMEOUTS,
    })
  }, [debts, db, domains, key])
}
