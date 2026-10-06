import { act } from 'react'
import { create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTouchGuard } from './use-touch-guard'

const protect = vi.fn(async (_enabled: boolean) => {})
vi.mock('../../../modules/touch-guard/src/TouchGuardModule', () => ({
  default: { protect: (e: boolean) => protect(e) },
}))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function Probe({ active }: { active: boolean }) {
  useTouchGuard(active)
  return null
}

beforeEach(() => protect.mockClear())

describe('useTouchGuard', () => {
  it('protects while mounted and active, and lets go on unmount', async () => {
    const renderer = await act(async () => create(<Probe active />))
    expect(protect.mock.calls).toEqual([[true]])
    await act(async () => renderer.unmount())
    expect(protect.mock.calls).toEqual([[true], [false]])
  })

  it('lets go when it stops being active, and does nothing while inactive', async () => {
    const renderer = await act(async () => create(<Probe active={false} />))
    expect(protect).not.toHaveBeenCalled()
    await act(async () => renderer.update(<Probe active />))
    await act(async () => renderer.update(<Probe active={false} />))
    expect(protect.mock.calls).toEqual([[true], [false]])
  })
})
