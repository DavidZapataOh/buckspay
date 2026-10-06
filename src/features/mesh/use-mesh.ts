import { useCallback, useEffect, useState } from 'react'
import type { MeshNative, MeshStartError } from './native'

export type Mesh = {
  enabled: boolean
  problem: MeshStartError | undefined
  setEnabled(on: boolean): Promise<void>
}

const PROBLEMS: readonly string[] = ['permission-denied', 'bluetooth-off', 'unsupported']

/** The "Help nearby payments" switch. The service remembers it, so a restart or a reboot keeps the choice. */
export function useMesh(native: MeshNative): Mesh {
  const [enabled, setEnabledState] = useState(false)
  const [problem, setProblem] = useState<MeshStartError>()

  useEffect(() => {
    let current = true
    void native.status().then((status) => current && setEnabledState(status.enabled))
    return () => {
      current = false
    }
  }, [native])

  const setEnabled = useCallback(
    async (on: boolean) => {
      setProblem(undefined)
      try {
        await (on ? native.start() : native.stop())
        setEnabledState(on)
      } catch (error) {
        const code = (error as { code?: string }).code ?? ''
        if (!PROBLEMS.includes(code)) throw error
        setProblem(code as MeshStartError)
        setEnabledState(false)
      }
    },
    [native],
  )

  return { enabled, problem, setEnabled }
}
