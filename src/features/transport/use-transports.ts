import AsyncStorage from '@react-native-async-storage/async-storage'
import { useCallback, useEffect, useState } from 'react'
import { AppState } from 'react-native'
import type { Availability, TransportId } from '../../transport/types'
import { hintFor } from './copy'
import type { PairingRole, TransportEntry } from './registry'

export type Offered = { entry: TransportEntry; availability: Availability }

/** Asks each entry whether it can run now, once on mount and again on `refresh`. */
export function useTransports(entries: readonly TransportEntry[]) {
  const [offered, setOffered] = useState<readonly Offered[]>([])
  const [round, setRound] = useState(0)
  useEffect(() => {
    let current = true
    void Promise.all(entries.map(async (entry) => ({ entry, availability: await entry.check() }))).then(
      (checked) => current && setOffered(checked),
    )
    return () => {
      current = false
    }
  }, [entries, round])
  const refresh = useCallback(() => setRound((n) => n + 1), [])
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => status === 'active' && refresh())
    return () => subscription.remove()
  }, [refresh])
  return { offered, ready: offered.filter((o) => o.availability.ready).map((o) => o.entry), refresh }
}

/** Whether a medium that is off could be turned on, which is worth a line of explanation. */
export const fixable = ({ entry, availability }: Offered) =>
  !availability.ready && hintFor(entry.id, availability.reason) !== undefined

/** The control is worth showing when there is a choice, or a medium the person can still turn on. */
export const showHow = (offered: readonly Offered[]) =>
  offered.filter((o) => o.availability.ready).length >= 2 || offered.some(fixable)

const storeKey = (role: PairingRole) => `how.${role}`

/** The medium of this role: the one it used last when it is ready, else the code. */
export function useTransportChoice(role: PairingRole, ready: readonly TransportEntry[]) {
  const [remembered, setRemembered] = useState<TransportId>()
  useEffect(() => {
    let current = true
    AsyncStorage.getItem(storeKey(role)).then(
      (id) => current && id && setRemembered(id as TransportId),
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [role])
  const chosen = ready.find((entry) => entry.id === remembered) ?? ready.find((entry) => entry.id === 'qr') ?? ready[0]
  const choose = useCallback(
    (id: TransportId) => {
      setRemembered(id)
      AsyncStorage.setItem(storeKey(role), id).catch(() => undefined)
    },
    [role],
  )
  return { chosen, choose }
}
