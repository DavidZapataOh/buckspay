import { act } from 'react'
import { create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { WitnessPolicy } from './policy'
import type { WitnessPort } from './port'
import type { WitnessResult } from './session'
import { useWitness } from './use-witness'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const messageId = new Uint8Array(32).fill(7)

function harness(policy: WitnessPolicy) {
  const pending: ((result: WitnessResult) => void)[] = []
  const port: WitnessPort = {
    attach: vi.fn(() => new Promise<WitnessResult>((resolve) => pending.push(resolve))),
    cancel: vi.fn(),
  }
  let current!: ReturnType<typeof useWitness>
  function Probe() {
    current = useWitness({ role: 'receiver', messageId, policy, port })
    return null
  }
  return { port, pending, hook: () => current, mount: () => act(async () => create(<Probe />)) }
}

describe('useWitness', () => {
  it('starts nothing when the policy is off', async () => {
    const { port, mount } = harness('off')
    await mount()
    expect(port.attach).not.toHaveBeenCalled()
  })

  it('runs one attempt and keeps its result', async () => {
    const { port, pending, hook, mount } = harness('auto')
    await mount()
    expect(port.attach).toHaveBeenCalledTimes(1)
    expect(hook().state.phase).toBe('checking')
    await act(async () => pending[0]({ status: 'seen', evidence: new Uint8Array(176) }))
    expect(hook().state.phase).toBe('seen')
  })

  it('skipping cancels the attempt and ignores its late result', async () => {
    const { port, pending, hook, mount } = harness('auto')
    await mount()
    await act(async () => hook().skip())
    expect(port.cancel).toHaveBeenCalledWith(messageId)
    await act(async () => pending[0]({ status: 'seen', evidence: new Uint8Array(176) }))
    expect(hook().state.phase).toBe('skipped')
  })

  it('tries again with a new attempt after not-seen', async () => {
    const { port, pending, hook, mount } = harness('auto')
    await mount()
    await act(async () => pending[0]({ status: 'not-seen' }))
    expect(hook().canRetry).toBe(true)
    await act(async () => hook().retry())
    expect(port.attach).toHaveBeenCalledTimes(2)
    expect(hook().state.attempts).toBe(2)
  })

  it('cancels a running attempt when the screen is left', async () => {
    const { port, mount } = harness('auto')
    const tree = await mount()
    await act(async () => tree.unmount())
    expect(port.cancel).toHaveBeenCalledWith(messageId)
  })
})
