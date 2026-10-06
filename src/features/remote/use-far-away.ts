import { useMobileWallet } from '@wallet-ui/react-native-kit'
import { useNetworkState } from 'expo-network'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { authenticate } from '../../payment/authenticate'
import { signStoredIssue } from '../../payment/native-sign'
import { confirmAndSend, PayError } from '../../payment/pay'
import { type PayContext, type PlanRefusal, planPayment } from '../../payment/preflight'
import { GRACE } from '../../protocol'
import { formatMoney } from '../../utils/format-amount'
import { deviceKeyCluster } from '../../keys'
import { genesisHashOf } from '../../payment/domains'
import { useOfflineLocks } from '../attesters/use-offline-locks'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { BUILD_GATEWAY } from '../lock/gateway'
import { paymentContext } from '../notes/outgoing'
import { PAY_LIMITS } from '../pay/limits'
import { BUILD_TOKEN, BUILD_TOKENS } from '../pay/tokens'
import { copy, text } from '../payment/copy'
import { nowSeconds, usePayments } from '../payment/payments-provider'
import { beaconsSeen } from '../relay/beacons'
import { runHandoffs } from '../relay/run'
import { l2capLink } from '../mesh/native'
import { settle } from '../settlement/settle'
import { type Contact, listContacts, saveContact } from './contacts'
import { decodePayLink } from './pay-link'
import { remoteRequest, REMOTE_MIN_WINDOW } from './plan'
import { refreshDeliveries } from './refresh'
import { type RemoteCtx, remoteSender, type RemoteOutcome, sealWithStored } from './send'
import { remoteCopy } from './copy'

const startOfToday = () => Math.floor(new Date().setHours(0, 0, 0, 0) / 1000)

/** Everything the Pay → Far away screen needs: the contacts, the plan of a payment, paying it, and keeping the outbox moving. */
export function useFarAway() {
  const { db, domains } = usePayments()
  const { deviceKey } = useDeviceIdentity()
  const offline = useOfflineLocks()
  const { client } = useMobileWallet()
  const online = useNetworkState().isInternetReachable === true && BUILD_GATEWAY !== null
  const [contacts, setContacts] = useState<Contact[]>([])
  const [pendingTo, setPendingTo] = useState<Uint8Array[]>([])
  const [context, setContext] = useState<PayContext>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const key = deviceKey?.publicKey
  const attesters = useMemo(() => [...new Set(offline.locks.map((lock) => lock.ticket.attester))], [offline.locks])

  const read = useCallback(async () => {
    if (!db) return undefined
    const open = await db.all<{ receiver: Uint8Array }>(
      `SELECT DISTINCT p.receiver FROM outgoing_payment p JOIN relay_outbox r ON r.message_id = p.message_id
       WHERE r.state IN ('signed', 'received', 'relaying')`,
    )
    return { contacts: await listContacts(db), pending: open.map((row) => row.receiver) }
  }, [db])
  const reload = useCallback(async () => {
    const found = await read()
    if (found) {
      setContacts(found.contacts)
      setPendingTo(found.pending)
    }
  }, [read])

  const contextNow = useCallback(async (): Promise<PayContext | undefined> => {
    if (!db || !key) return undefined
    return {
      now: nowSeconds(),
      me: key,
      noteDomain: domains.noteDomain,
      program: domains.program,
      locks: offline.locks,
      tokens: BUILD_TOKENS,
      limits: PAY_LIMITS,
      salt: () => crypto.getRandomValues(new Uint8Array(16)),
      ...(await paymentContext(db, startOfToday())),
    }
  }, [db, key, domains, offline.locks])

  const maintain = useCallback(async () => {
    if (!db) return
    const cluster = deviceKeyCluster()
    if (cluster) {
      await runHandoffs({
        db,
        link: l2capLink,
        clusterTag: genesisHashOf(cluster).slice(0, 4),
        beacons: beaconsSeen(nowSeconds()),
        now: nowSeconds(),
      }).catch(() => undefined)
    }
    if (online) await refreshDeliveries(db, client.rpc, domains.program, nowSeconds()).catch(() => undefined)
  }, [db, online, client.rpc, domains.program])

  useEffect(() => {
    let current = true
    void read().then((found) => {
      if (!current || !found) return
      setContacts(found.contacts)
      setPendingTo(found.pending)
    })
    void contextNow().then((next) => current && setContext(next))
    return () => {
      current = false
    }
  }, [read, contextNow])
  useEffect(() => {
    let current = true
    void maintain()
      .then(read)
      .then((found) => {
        if (!current || !found) return
        setContacts(found.contacts)
        setPendingTo(found.pending)
      })
    return () => {
      current = false
    }
  }, [maintain, read])

  const planFor = (contact: Contact, amount: bigint, at: PayContext) => {
    const request = remoteRequest(contact, amount, '', { now: at.now, attesters })
    return { request, planned: planPayment(request, at) }
  }

  const deadlineFor = (contact: Contact, amount: bigint) => {
    const planned = context && attesters.length > 0 ? planFor(contact, amount, context).planned : undefined
    return planned?.ok ? planned.plan.review.expiry + GRACE : nowSeconds() + REMOTE_MIN_WINDOW + GRACE
  }

  const refusalLine = (reason: PlanRefusal, amount: bigint) =>
    text(copy.refusal[reason].text, {
      max: formatMoney(PAY_LIMITS.maxPayment, BUILD_TOKEN.decimals),
      amount: formatMoney(amount, BUILD_TOKEN.decimals),
      allowance: formatMoney(offline.allowance(), BUILD_TOKEN.decimals),
    })

  async function pay(contact: Contact, amount: bigint): Promise<RemoteOutcome | undefined> {
    const cluster = deviceKeyCluster()
    if (!db || !cluster) return undefined
    setBusy(true)
    setError(undefined)
    try {
      const at = await contextNow()
      if (!at) return undefined
      const { request, planned } = planFor(contact, amount, at)
      if (!planned.ok) {
        setError(refusalLine(planned.reason, amount))
        return undefined
      }
      const gateway = BUILD_GATEWAY
      let outcome: RemoteOutcome = 'queued'
      const remote: RemoteCtx = {
        db,
        online: online && gateway !== null,
        now: nowSeconds,
        noteDomain: domains.noteDomain,
        settleDirect: (settlement) => settle(gateway!, settlement),
        seal: sealWithStored(db, genesisHashOf(cluster)),
      }
      await confirmAndSend(planned.plan, request, 'remote', {
        db,
        sign: signStoredIssue,
        authenticate: (due) =>
          authenticate(
            copy.review.promptTitle,
            text(copy.review.promptSubtitle, {
              amount: formatMoney(due, BUILD_TOKEN.decimals),
              symbol: BUILD_TOKEN.symbol,
              code: contact.name,
            }),
            copy.review.cancel,
          ),
        noteDomain: domains.noteDomain,
        now: nowSeconds,
        transport: remoteSender(remote, (result) => (outcome = result)),
      })
      await maintain()
      await reload()
      return outcome
    } catch (failure) {
      if (!(failure instanceof PayError && failure.code === 'Declined')) setError(remoteCopy.failed)
      return undefined
    } finally {
      setBusy(false)
    }
  }

  /** Saves a pay link from a scan or a paste; the message says why it was not accepted. */
  async function addLink(link: string): Promise<string | undefined> {
    if (!db) return remoteCopy.failed
    try {
      await saveContact(db, decodePayLink(link), nowSeconds(), online ? client.rpc : null)
    } catch {
      return remoteCopy.notALink
    }
    await reload()
    return undefined
  }

  return { contacts, pendingTo, online, busy, error, deadlineFor, pay, addLink }
}
