import { fetchMaybeDevice, findDevicePda } from '@project/anchor'
import { useCallback, useEffect, useState } from 'react'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { formatError } from '../../utils/format-error'
import { type LockRecord, readLocks } from './locks'
import { useOperationContext } from './use-operation-context'

export type LocksState = {
  /** This device key's locks, oldest first. */
  locks?: LockRecord[]
  /** The number the key's next lock takes. */
  nextLockSeq?: number
  error?: string
  loading: boolean
}

/** Reads this phone's locks from Solana, again on `refresh`. */
export function useLocks() {
  const { rpc, programAddress } = useOperationContext()
  const { deviceKey, step } = useDeviceIdentity()
  const [state, setState] = useState<LocksState>({ loading: true })
  const key = deviceKey?.publicKey

  const refresh = useCallback(async () => {
    if (!key || step !== 'ready') return
    setState((current) => ({ ...current, loading: true }))
    try {
      const [device] = await findDevicePda(key, programAddress)
      const [locks, account] = await Promise.all([
        readLocks(rpc, programAddress, key),
        fetchMaybeDevice(rpc, device, { commitment: 'confirmed' }),
      ])
      setState({ locks, nextLockSeq: account.exists ? account.data.nextLockSeq : undefined, loading: false })
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: `Couldn’t read your locks. ${formatError(error)}`,
      }))
    }
  }, [key, step, rpc, programAddress])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { ...state, refresh }
}
