import { act } from 'react'
import { create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { qrMatrix } from '../../transport/qr/matrix'
import { QrPresenter } from './qr-presenter'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('react-native-svg', () => ({ default: 'Svg', Svg: 'Svg', Path: 'Path', Rect: 'Rect' }))
vi.mock('uniwind', () => ({ useCSSVariable: () => '#000000' }))
vi.mock('expo-brightness', () => ({
  setBrightnessAsync: vi.fn(async () => {}),
  restoreSystemBrightnessAsync: vi.fn(async () => {}),
}))
vi.mock('expo-keep-awake', () => ({ useKeepAwake: vi.fn() }))
vi.mock('../../transport/qr/matrix', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../transport/qr/matrix')>()
  return { qrMatrix: vi.fn(original.qrMatrix) }
})

const Brightness = await import('expo-brightness')

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const texts = ['BP:0', 'BP:1', 'BP:2']
const mount = async (list: readonly string[]) =>
  act(async () => create(<QrPresenter texts={list} accessibilityLabel="Payment code" />))
const shown = (renderer: Awaited<ReturnType<typeof mount>>) =>
  renderer.root.findAll((node) => typeof node.props.text === 'string')[0].props.text

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})
afterEach(() => vi.useRealTimers())

describe('QrPresenter', () => {
  it('shows the first text and the next every 200 ms, wrapping', async () => {
    const renderer = await mount(texts)
    const seen = [shown(renderer)]
    for (let tick = 0; tick < 3; tick++) {
      await act(async () => vi.advanceTimersByTime(200))
      seen.push(shown(renderer))
    }
    expect(seen).toEqual(['BP:0', 'BP:1', 'BP:2', 'BP:0'])
  })

  it('does not start a timer for one text', async () => {
    await mount(['BP:0'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('computes the matrices once per message', async () => {
    await mount(texts)
    await act(async () => vi.advanceTimersByTime(200 * 20))
    expect(qrMatrix).toHaveBeenCalledTimes(texts.length)
  })

  it('raises the brightness while mounted and restores it on unmount', async () => {
    const renderer = await mount(texts)
    expect(Brightness.setBrightnessAsync).toHaveBeenCalledWith(1)
    await act(async () => renderer.unmount())
    expect(Brightness.restoreSystemBrightnessAsync).toHaveBeenCalledTimes(1)
  })

  it('clears its timer on unmount', async () => {
    const renderer = await mount(texts)
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => renderer.unmount())
    expect(vi.getTimerCount()).toBe(0)
  })
})
