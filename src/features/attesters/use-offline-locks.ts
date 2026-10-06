import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import type { BondTicket } from '../../protocol'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { BUILD_FUNDING_MINT } from '../lock/build-funding'
import { useLocks } from '../lock/use-locks'
import { nextCumEnd } from '../notes/outgoing'
import { nowSeconds, usePayments } from '../payment/payments-provider'
import { allowance, needsRefresh, offlineLocks } from './offline-locks'
import { loadTickets, MAX_TICKET_BATCH, requestTickets, saveTickets, type TicketLifetime } from './tickets'

/** The least time between two requests for tickets, milliseconds, whatever changed in between. */
const MIN_ASK_INTERVAL = 60_000

const ATTESTER_URL = process.env.EXPO_PUBLIC_ATTESTER_URL ?? process.env.EXPO_PUBLIC_GATEWAY_URL

/**
 * The locks this phone can pay from: the active locks of its device key, each with the ticket its
 * attester signed and where its next issue starts. Tickets are asked for again when a lock has none or
 * the earliest has less than 12 hours left, and kept when the attester cannot be reached.
 */
export function useOfflineLocks() {
  const { locks: chain, refresh: refreshChain } = useLocks()
  const { deviceKey } = useDeviceIdentity()
  const { db } = usePayments()
  const key = deviceKey?.publicKey
  const [tickets, setTickets] = useState<ReadonlyMap<number, BondTicket>>(new Map())
  const [cursors, setCursors] = useState<ReadonlyMap<number, bigint>>(new Map())
  const [refused, setRefused] = useState<readonly { lockSeq: number; reason: string }[]>([])
  const asking = useRef(false)
  const lastAsked = useRef(0)

  const active = useMemo(
    () =>
      (chain ?? []).filter((lock) => !lock.withdrawn && lock.mint === BUILD_FUNDING_MINT).map((lock) => lock.lockSeq),
    [chain],
  )

  const snapshot = useCallback(async () => {
    if (!key || !db) return undefined
    const cursorsOf = await Promise.all(active.map(async (seq) => [seq, await nextCumEnd(db, key, seq)] as const))
    return { tickets: await loadTickets(key), cursors: new Map(cursorsOf) }
  }, [key, db, active])

  const read = useCallback(async () => {
    const stored = await snapshot()
    if (stored) {
      setTickets(stored.tickets)
      setCursors(stored.cursors)
    }
  }, [snapshot])

  useEffect(() => {
    let current = true
    void snapshot().then((stored) => {
      if (!current || !stored) return
      setTickets(stored.tickets)
      setCursors(stored.cursors)
    })
    return () => {
      current = false
    }
  }, [snapshot])

  const refresh = useCallback(
    async (lifetime: TicketLifetime = 86_400) => {
      if (!key || !ATTESTER_URL || active.length === 0 || asking.current) return
      asking.current = true
      lastAsked.current = Date.now()
      try {
        const answer = await requestTickets(ATTESTER_URL, key, active.slice(0, MAX_TICKET_BATCH), lifetime)
        await saveTickets(key, answer.tickets)
        setRefused(answer.refused)
        await read()
      } finally {
        asking.current = false
      }
    },
    [key, active, read],
  )

  const locks = useMemo(() => offlineLocks(tickets, active, cursors), [tickets, active, cursors])

  useEffect(() => {
    const check = () => {
      // A lock the attester refused is shown as refused and not asked about again until it changes.
      const wanted = active.filter((seq) => !refused.some(({ lockSeq }) => lockSeq === seq))
      if (Date.now() - lastAsked.current < MIN_ASK_INTERVAL) return
      if (needsRefresh(wanted, locks, nowSeconds())) void refresh().catch(() => {})
    }
    check()
    const subscription = AppState.addEventListener('change', (status) => status === 'active' && check())
    return () => subscription.remove()
  }, [active, locks, refused, refresh])

  return {
    locks,
    refused,
    allowance: () => allowance(locks, nowSeconds()),
    /** Reads the locks and the tickets again, after a payment, a new lock or a refresh. */
    reload: async () => {
      await refreshChain()
      await read()
    },
    refresh,
  }
}
