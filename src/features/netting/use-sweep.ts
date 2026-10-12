import { useEffect } from 'react'

type Unsubscribe = () => void
type Source<T> = { subscribe: (listener: (value: T) => void) => Unsubscribe }

/** Where the sweep hears about the app coming to the front, the Activity screen focusing and the network returning. */
export type SweepSources = {
  appState: Source<'active' | 'background' | 'inactive'>
  focus: { subscribe: (listener: () => void) => Unsubscribe }
  connectivity: Source<boolean>
}

const later = (attach: () => Promise<() => void>) => {
  let stop: (() => void) | undefined
  let cancelled = false
  void attach().then((detach) => {
    if (cancelled) detach()
    else stop = detach
  })
  return () => {
    cancelled = true
    stop?.()
  }
}

const defaultSources = (): SweepSources => ({
  appState: {
    subscribe: (listener) =>
      later(async () => {
        const { AppState } = await import('react-native')
        const subscription = AppState.addEventListener('change', (state) =>
          listener(state === 'active' || state === 'background' ? state : 'inactive'),
        )
        return () => subscription.remove()
      }),
  },
  focus: { subscribe: () => () => undefined },
  connectivity: {
    subscribe: (listener) =>
      later(async () => {
        const { addNetworkStateListener } = await import('expo-network')
        const subscription = addNetworkStateListener((state) => listener(!!state.isInternetReachable))
        return () => subscription.remove()
      }),
  },
})

/**
 * Runs `run` on mount, when the app comes to the front, on Activity focus and when connectivity returns; never two
 * at once (an event during a run schedules exactly one more run after it).
 */
export function useNettingSweep(run: () => Promise<unknown>, sources: SweepSources = defaultSources()): void {
  useEffect(() => {
    let running = false
    let again = false
    let alive = true
    const trigger = async (): Promise<void> => {
      if (running) {
        again = true
        return
      }
      running = true
      try {
        await run()
      } catch (error) {
        console.warn('The netting sweep failed and will run again.', error)
      } finally {
        running = false
        if (again && alive) {
          again = false
          void trigger()
        }
      }
    }
    void trigger()
    const stops = [
      sources.appState.subscribe((state) => state === 'active' && void trigger()),
      sources.focus.subscribe(() => void trigger()),
      sources.connectivity.subscribe((online) => online && void trigger()),
    ]
    return () => {
      alive = false
      stops.forEach((stop) => stop())
    }
    // The sources and `run` are fixed for the life of the component that mounts the sweep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
