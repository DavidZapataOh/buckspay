import { act, type ReactElement, useEffect } from 'react'
import { create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupWire } from '../../transport/nearby/group'
import type { SessionEvent } from './member'

const wire = { close: vi.fn(async () => undefined) } as unknown as GroupWire
const openHub = vi.fn(async () => wire)
// A screen that keeps asking runs out of the debts context after a few renders, so it cannot run away with the test.
let renders = 0
const debts = {
  db: {},
  now: () => 1_800_000_000,
  random: (n: number) => new Uint8Array(n).fill(7),
  iouDomain: new Uint8Array(32),
  mint: new Uint8Array(32),
  me: new Uint8Array(33),
  sign: async () => new Uint8Array(64),
}

vi.mock('../debts/use-debts', () => ({ useDebts: () => (renders++ > 30 ? undefined : debts) }))
vi.mock('../../keys', () => ({ deviceKeyCluster: () => 'devnet' }))
vi.mock('./open-group', () => ({ openHub: () => openHub(), openSpoke: vi.fn() }))
let fire: (event: SessionEvent) => void = () => undefined
let hostEnds: Promise<unknown> = new Promise<never>(() => undefined)
vi.mock('./host', () => ({
  runHost: (deps: { onEvent: (event: SessionEvent) => void }) => {
    fire = deps.onEvent
    return hostEnds
  },
}))
const rows = [{ tab: 'aa', role: 'debtor' as const, amount: 5n, state: 'due' as const }]
vi.mock('./remainder-rows', () => ({
  remainderTabsOf: vi.fn(async () => [{ tab: new Uint8Array(32) }]),
  loadRemainderRows: vi.fn(async () => rows),
}))
vi.mock('./remainder', () => ({ collectRemainder: vi.fn(async () => undefined) }))
vi.mock('./use-remainder-deps', () => ({ useRemainderDeps: () => undefined }))
vi.mock('./prove', () => ({ proveNetting: vi.fn(), verifyNettingProof: vi.fn() }))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { useHostSession } = await import('./use-session')

const seen: { current?: ReturnType<typeof useHostSession> } = {}
function Probe(): ReactElement | null {
  const session = useHostSession()
  const { open } = session
  useEffect(() => {
    seen.current = session
  })
  useEffect(() => {
    void open()
  }, [open])
  return null
}

describe('useHostSession', () => {
  beforeEach(() => {
    renders = 0
    openHub.mockClear()
    hostEnds = new Promise<never>(() => undefined)
  })

  it('opens_the_radio_once_however_many_times_the_screen_renders', async () => {
    await act(async () => {
      create(<Probe />)
      for (let tick = 0; tick < 20; tick++) await Promise.resolve()
    })
    expect(openHub).toHaveBeenCalledTimes(1)
  })

  it('shows_the_collecting_state_as_soon_as_the_person_presses_start', async () => {
    await act(async () => {
      create(<Probe />)
      for (let tick = 0; tick < 20; tick++) await Promise.resolve()
    })
    await act(async () => seen.current!.start())
    expect(seen.current?.view?.state).toBe('collecting')
  })

  it('keeps_the_outcome_and_follows_the_phases_of_the_session', async () => {
    await act(async () => {
      create(<Probe />)
      for (let tick = 0; tick < 20; tick++) await Promise.resolve()
    })
    await act(async () => fire({ type: 'phase', status: 2 }))
    expect(seen.current?.view?.state).toBe('waiting')
    await act(async () => fire({ type: 'ended', outcome: { status: 'nothing', peers: [] } }))
    expect(seen.current?.outcome).toEqual({ status: 'nothing', peers: [] })
  })

  it('lists_what_is_left_to_pay_once_the_session_ends', async () => {
    hostEnds = Promise.resolve({ status: 'nothing', peers: [] })
    await act(async () => {
      create(<Probe />)
      for (let tick = 0; tick < 30; tick++) await Promise.resolve()
    })
    expect(seen.current?.remainder).toEqual(rows)
  })
})
