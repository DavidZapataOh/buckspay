import { useEffect } from 'react'
import TouchGuard from '../../../modules/touch-guard/src/TouchGuardModule'

/** While `active` and mounted, the window drops touches made through an overlay and hides its content from non-tool accessibility services. */
export function useTouchGuard(active: boolean) {
  useEffect(() => {
    if (!active) return
    void TouchGuard.protect(true)
    return () => void TouchGuard.protect(false)
  }, [active])
}
