import { useCallback, useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { useDeviceIdentity } from '../identity/use-device-identity'
import { readPendingRotation, type RotationAlert } from './rotation-watch'
import { useOperationContext } from './use-operation-context'

/** The wallet rotation pending on this phone's key, read when the app opens and each time it resumes. */
export function useRotationWatch() {
  const { rpc, programAddress } = useOperationContext()
  const { deviceKey, step } = useDeviceIdentity()
  const [alert, setAlert] = useState<RotationAlert>()
  const [reads, setReads] = useState(0)
  const key = deviceKey?.publicKey

  useEffect(() => {
    if (!key || step !== 'ready') return
    let current = true
    // Unreadable now: the alert stays as it was, and the next resume reads again.
    const read = () =>
      readPendingRotation(rpc, programAddress, key).then(
        (pending) => current && setAlert(pending),
        () => {},
      )
    void read()
    const subscription = AppState.addEventListener('change', (status) => status === 'active' && void read())
    return () => {
      current = false
      subscription.remove()
    }
  }, [key, step, rpc, programAddress, reads])

  const refresh = useCallback(() => setReads((count) => count + 1), [])
  return { alert, refresh }
}
