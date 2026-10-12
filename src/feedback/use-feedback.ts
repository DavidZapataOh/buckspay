import { useCallback, useEffect, useState } from 'react'
import { feedback } from '.'
import { DEFAULT_PREFS, type FeedbackPrefs, loadFeedbackPreferences, saveFeedbackPreferences } from './preferences'

/** Loads what the person chose once, when the app opens, so the first tap already follows it. */
export function useFeedbackBootstrap() {
  useEffect(() => {
    void loadFeedbackPreferences().then((prefs) => feedback.set(prefs))
  }, [])
}

/** The sound and vibration choices of Settings. */
export function useFeedbackPreferences() {
  const [prefs, setPrefs] = useState<FeedbackPrefs>(feedback.get())
  useEffect(() => {
    let current = true
    void loadFeedbackPreferences().then((loaded) => current && setPrefs(loaded))
    return () => {
      current = false
    }
  }, [])
  const choose = useCallback(async (next: FeedbackPrefs) => {
    setPrefs(next)
    feedback.set(next)
    await saveFeedbackPreferences(next)
  }, [])
  return { prefs, choose, defaults: DEFAULT_PREFS }
}
