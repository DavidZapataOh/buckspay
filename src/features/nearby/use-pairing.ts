import { useCallback, useEffect, useRef, useState } from 'react'
import { Linking } from 'react-native'
import { nearbyNative, requestNearbyPermissions } from '../../transport/nearby/native'
import {
  type Confirming,
  DEFAULT_PAIRING,
  NearbyFinder,
  NearbyHost,
  type PairingFailure,
  type Peer,
} from '../../transport/nearby/pairing'
import { nearbyAvailability } from '../../transport/nearby/transport'
import type { NearbyLink } from '../../transport/nearby/types'
import type { Availability } from '../../transport/types'
import type { PairingRole } from './handoff'

export type PairingStatus =
  | { name: 'checking' }
  | { name: 'blocked'; reason: Extract<Availability, { ready: false }>['reason'] }
  | { name: 'running' }
  | { name: 'failed'; reason: PairingFailure }
  | { name: 'connected' }

const options = {
  ...DEFAULT_PAIRING,
  random: (length: number) => crypto.getRandomValues(new Uint8Array(length)),
}

/** Runs one pairing for `role` and reports it; `onLink` fires once, when both people confirmed. */
export function usePairing(role: PairingRole, onLink: (link: NearbyLink) => void) {
  const [status, setStatus] = useState<PairingStatus>({ name: 'checking' })
  const [tag, setTag] = useState<string>()
  const [peers, setPeers] = useState<Peer[]>([])
  const [confirming, setConfirming] = useState<Confirming | null>(null)
  const [round, setRound] = useState(0)
  const [deadline, setDeadline] = useState<number>()
  const session = useRef<NearbyHost | NearbyFinder>(undefined)
  const finder = useRef<NearbyFinder>(undefined)
  const link = useRef(onLink)
  useEffect(() => {
    link.current = onLink
  })

  useEffect(() => {
    let cancelled = false
    const stops: (() => void)[] = []
    void (async () => {
      const availability = nearbyAvailability(await nearbyNative.support())
      if (cancelled) return
      if (!availability.ready) return setStatus({ name: 'blocked', reason: availability.reason })
      try {
        const started =
          role === 'receiver'
            ? await NearbyHost.start(nearbyNative, options)
            : await NearbyFinder.start(nearbyNative, options)
        session.current = started
        if (cancelled) return void started.stop()
        if (started instanceof NearbyHost) setTag(started.tag)
        else {
          finder.current = started
          setPeers(started.peers)
          stops.push(started.subscribePeers(setPeers))
        }
        stops.push(
          started.subscribe((current) => {
            setConfirming(current)
            if (current) setDeadline(Date.now() / 1000 + DEFAULT_PAIRING.confirmTimeoutMs / 1000)
          }),
        )
        setStatus({ name: 'running' })
        started.connected.then(
          (connected) => {
            if (cancelled) return
            setStatus({ name: 'connected' })
            link.current(connected)
          },
          (error: { reason?: PairingFailure }) =>
            !cancelled && setStatus({ name: 'failed', reason: error.reason ?? 'Error' }),
        )
      } catch (error) {
        if (!cancelled) setStatus({ name: 'failed', reason: (error as { reason?: PairingFailure }).reason ?? 'Error' })
      }
    })()
    return () => {
      cancelled = true
      stops.forEach((stop) => stop())
      void session.current?.stop()
    }
  }, [role, round])

  const restart = useCallback(() => {
    setStatus({ name: 'checking' })
    setConfirming(null)
    setRound((value) => value + 1)
  }, [])
  const allow = useCallback(async () => {
    await requestNearbyPermissions().catch(() => {})
    restart()
  }, [restart])
  return {
    status,
    tag,
    peers,
    confirming,
    /** Unix seconds at which the person has run out of time to compare the digits. */
    deadline,
    restart,
    allow,
    openBluetoothSettings: () => void Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS'),
    pick: (endpointId: string) => void finder.current?.connect(endpointId).catch(() => {}),
    confirm: () => void session.current?.confirm(),
    decline: () => void session.current?.decline(),
  }
}
