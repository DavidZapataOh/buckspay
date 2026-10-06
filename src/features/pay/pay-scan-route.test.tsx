import { act } from 'react'
import { create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ back: vi.fn(), routerBack: vi.fn(), flow: {} as Record<string, unknown> }))

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('expo-router', () => ({ router: { back: mocks.routerBack, replace: vi.fn() } }))
vi.mock('./use-pay-flow', () => ({ usePayFlow: () => mocks.flow }))
vi.mock('../qr/scan-screen', () => ({ ScanScreen: () => null }))
vi.mock('../transport/waiting', () => ({ WaitingScreen: () => null }))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const freshFlow = (name: string) => ({
  state: { name },
  stateName: () => name,
  how: { chosen: 'qr' },
  progress: undefined,
  submitText: vi.fn(),
  back: mocks.back,
})

describe('pay scan screen', () => {
  beforeEach(() => {
    mocks.back.mockClear()
    mocks.routerBack.mockClear()
  })

  it('stays open while the flow value is replaced during scanning, and cancels once on unmount', async () => {
    const { default: PayScan } = await import('../../app/pay/scan')
    mocks.flow = freshFlow('scanning')
    let tree!: ReturnType<typeof create>
    await act(async () => {
      tree = create(<PayScan />)
    })
    mocks.flow = freshFlow('scanning')
    await act(async () => tree.update(<PayScan />))
    mocks.flow = freshFlow('scanning')
    await act(async () => tree.update(<PayScan />))
    expect(mocks.back).not.toHaveBeenCalled()
    expect(mocks.routerBack).not.toHaveBeenCalled()
    await act(async () => tree.unmount())
    expect(mocks.back).toHaveBeenCalledTimes(1)
  })
})
