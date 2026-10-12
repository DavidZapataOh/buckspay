import { useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { initLanguage } from '.'

/** Activates the person's language, or the phone's; true once the first screen can be painted in it. */
export function useLanguageBootstrap(): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    void initLanguage().finally(() => setReady(true))
    const state = AppState.addEventListener('change', (status) => status === 'active' && void initLanguage())
    return () => state.remove()
  }, [])
  return ready
}
