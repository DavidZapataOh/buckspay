import { useEffect, useState } from 'react'

/** Whole seconds until `expiresAt` (Unix seconds), once a second, never below zero. */
export function useSecondsLeft(expiresAt: number | undefined, now: () => number = () => Date.now() / 1000): number {
  const [, tick] = useState(0)
  useEffect(() => {
    if (expiresAt === undefined) return
    const timer = setInterval(() => tick((count) => count + 1), 1000)
    return () => clearInterval(timer)
  }, [expiresAt])
  return expiresAt === undefined ? 0 : Math.max(0, Math.ceil(expiresAt - now()))
}
