import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { Reason } from '../../payment/reasons'
import { pointReasonText } from '../event/copy'
import { PointStatus } from '../event/point-status'
import { RejectedResult } from './result'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('expo-symbols', () => ({ unstable_getMaterialSymbolSourceAsync: vi.fn(async () => ({ uri: 'icon.png' })) }))
vi.mock('expo-haptics', () => ({ notificationAsync: vi.fn(async () => {}), NotificationFeedbackType: {} }))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const texts = (root: ReactTestInstance) =>
  root.findAllByType('Text' as never).map((node) => [node.props.children].flat().join(''))
const render = async (element: React.ReactElement) => (await act(async () => create(element))).root
const limits = { window: 3600, max: 100_000_000n, symbol: 'USDC', decimals: 6 }

describe('point mode', () => {
  it('shows a double spend as already spent at another point', async () => {
    const why = pointReasonText(Reason.DoubleSpend) ?? undefined
    const root = await render(
      <RejectedResult reason={Reason.DoubleSpend} why={why} limits={limits} onRetry={() => {}} onDone={() => {}} />,
    )
    expect(texts(root)).toContain('Already spent at another point')
  })

  it('leaves the reasons it does not reword to the ordinary text', () => {
    expect(pointReasonText(Reason.Expired)).toBeNull()
  })

  it('shows how many points it is linked to and how long ago it last heard them', async () => {
    const root = await render(<PointStatus status={{ peers: 2, syncedAt: 1_000 }} now={1_012} />)
    expect(texts(root)).toEqual(['Synced with 2 points, 12 s ago'])
  })

  it('says so when no point is linked or the first sync has not come', async () => {
    const none = await render(<PointStatus status={{ peers: 0, syncedAt: null }} now={0} />)
    expect(texts(none)).toEqual(['No other point is linked.'])
    const waiting = await render(<PointStatus status={{ peers: 1, syncedAt: null }} now={0} />)
    expect(texts(waiting)).toEqual(['Linked with 1 points, waiting for the first sync.'])
  })
})
