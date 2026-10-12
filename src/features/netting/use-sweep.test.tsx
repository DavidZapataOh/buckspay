import { act, type ReactElement } from 'react'
import { create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { useNettingSweep, type SweepSources } from './use-sweep'

const fakeSources = () => {
  const l = {
    app: new Set<(s: 'active' | 'background' | 'inactive') => void>(),
    focus: new Set<() => void>(),
    net: new Set<(o: boolean) => void>(),
  }
  const sub = <T,>(set: Set<T>) => ({
    subscribe: (fn: T) => {
      set.add(fn)
      return () => set.delete(fn)
    },
  })
  const sources: SweepSources = {
    appState: sub(l.app) as never,
    focus: sub(l.focus) as never,
    connectivity: sub(l.net) as never,
  }
  return { sources, l }
}
function Probe({ run, sources }: { run: () => Promise<unknown>; sources: SweepSources }): ReactElement | null {
  useNettingSweep(run, sources)
  return null
}
const mount = async (run: () => Promise<unknown>, sources: SweepSources) =>
  act(async () => {
    create(<Probe run={run} sources={sources} />)
  })

describe('useNettingSweep', () => {
  it('app_start_sweeps_sessions_and_repays', async () => {
    const run = vi.fn(async () => {})
    const { sources, l } = fakeSources()
    await mount(run, sources)
    expect(run).toHaveBeenCalledTimes(1)
    await act(async () => l.app.forEach((f) => f('active')))
    expect(run).toHaveBeenCalledTimes(2)
    await act(async () => l.app.forEach((f) => f('background')))
    expect(run).toHaveBeenCalledTimes(2)
    await act(async () => l.focus.forEach((f) => f()))
    expect(run).toHaveBeenCalledTimes(3)
    await act(async () => l.net.forEach((f) => f(false)))
    expect(run).toHaveBeenCalledTimes(3)
    await act(async () => l.net.forEach((f) => f(true)))
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('sweeps_never_overlap', async () => {
    let release!: () => void
    let running = 0
    let peak = 0
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          running++
          peak = Math.max(peak, running)
          release = () => {
            running--
            resolve()
          }
        }),
    )
    const { sources, l } = fakeSources()
    await mount(run, sources)
    await act(async () => {
      l.focus.forEach((f) => f())
      l.app.forEach((f) => f('active'))
      l.net.forEach((f) => f(true))
    })
    expect(run).toHaveBeenCalledTimes(1)
    await act(async () => release())
    expect(run).toHaveBeenCalledTimes(2)
    await act(async () => release())
    expect(peak).toBe(1)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('a_failing_run_does_not_stop_later_runs', async () => {
    const run = vi.fn(async () => {
      throw new Error('offline')
    })
    const { sources, l } = fakeSources()
    await mount(run, sources)
    await act(async () => l.focus.forEach((f) => f()))
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('the_root_layout_mounts_one_nettingsweep_after_the_debts_stack_line', () => {
    const layout = readFileSync(new URL('../../app/_layout.tsx', import.meta.url), 'utf8')
    expect(layout.match(/<NettingSweep \/>/g)).toHaveLength(1)
    expect(layout.indexOf('<NettingSweep />')).toBeGreaterThan(layout.indexOf('name="debts"'))
  })
})
