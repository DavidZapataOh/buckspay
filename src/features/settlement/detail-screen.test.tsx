import { act } from 'react'
import { create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settlement: {} as Record<string, unknown>,
  outputId: new Uint8Array(32).fill(5),
  payments: { db: {} },
}))

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (n: string | string[]) => (Array.isArray(n) ? n.map(() => '#000000') : '#000000'),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
vi.mock('expo-symbols', () => ({ unstable_getMaterialSymbolSourceAsync: vi.fn(async () => ({ uri: 'icon.png' })) }))
vi.mock('expo-router', () => ({
  router: { push: vi.fn(), back: vi.fn() },
  useLocalSearchParams: () => ({ id: 'received-x' }),
}))
vi.mock('expo-linking', () => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })), openURL: vi.fn() }))
vi.mock('../activity/format', async (original) => ({
  ...(await original<object>()),
  parseActivityId: () => ({ kind: 'received', id: new Uint8Array(32) }),
}))
vi.mock('../notes/activity', () => ({
  activityDetail: async () => ({
    kind: 'received',
    id: new Uint8Array(32),
    outputId: mocks.outputId,
    state: 'settling',
    amount: 1_000_000n,
    at: 1_800_000_000,
  }),
}))
vi.mock('../payment/payments-provider', () => ({ usePayments: () => mocks.payments }))
vi.mock('../pay/use-pay-flow', () => ({ usePayFlow: () => ({}) }))
vi.mock('./use-settlement-runner', () => ({ useSettlementRunner: () => mocks.settlement }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const report = (over: object) => ({
  settled: 0,
  waiting: 1,
  failed: 0,
  refused: [],
  stalled: [],
  lost: [],
  notices: [],
  private: [],
  ...over,
})

describe('a payment that is still settling', () => {
  let settleNow: ReturnType<typeof vi.fn>
  let confirmNotice: ReturnType<typeof vi.fn>
  beforeEach(() => {
    settleNow = vi.fn(async () => {})
    confirmNotice = vi.fn(async () => {})
  })

  async function show(over: object) {
    mocks.settlement = { report: report(over), settleNow, confirmNotice, running: false, notices: [] }
    const { default: Detail } = await import('../../app/activity/[id]')
    let tree!: ReturnType<typeof create>
    await act(async () => {
      tree = create(<Detail />)
    })
    return tree
  }
  const press = (tree: ReturnType<typeof create>, testID: string) =>
    act(async () =>
      tree.root.findAll((n) => n.props.testID === testID && typeof n.type === 'string')[0].props.onPress(),
    )

  it('asks to settle this note, not whatever is next', async () => {
    const tree = await show({})
    await press(tree, 'settle-now')
    expect(settleNow).toHaveBeenCalledWith(mocks.outputId)
  })

  it('says it waits for the person and offers to settle in the clear', async () => {
    const tree = await show({ notices: [{ outputId: mocks.outputId, holders: 2 }] })
    expect(JSON.stringify(tree.toJSON())).toContain('Waiting for you to read')
    await press(tree, 'settle-in-clear')
    expect(confirmNotice).toHaveBeenCalledWith(mocks.outputId)
  })

  it('says what the server answered', async () => {
    const tree = await show({
      refused: [{ outputId: mocks.outputId, kind: 'lock', selfPay: false, reason: 'no_lock' }],
    })
    expect(JSON.stringify(tree.toJSON())).toContain('no_lock')
  })
})
