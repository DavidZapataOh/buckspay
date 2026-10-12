import { act, type ReactElement, useEffect } from 'react'
import { create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { GroupWire } from '../../transport/nearby/group'

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
vi.mock('./host', () => ({ runHost: () => new Promise<never>(() => undefined) }))
vi.mock('./prove', () => ({ proveNetting: vi.fn(), verifyNettingProof: vi.fn() }))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { useHostSession } = await import('./use-session')

function Probe(): ReactElement | null {
  const { open } = useHostSession()
  useEffect(() => {
    void open()
  }, [open])
  return null
}

describe('useHostSession', () => {
  it('opens_the_radio_once_however_many_times_the_screen_renders', async () => {
    await act(async () => {
      create(<Probe />)
      for (let tick = 0; tick < 20; tick++) await Promise.resolve()
    })
    expect(openHub).toHaveBeenCalledTimes(1)
  })
})
