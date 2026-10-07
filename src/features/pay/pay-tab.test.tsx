import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { encodeIssueBody, type Issue } from '../../protocol'
import { MINT, party } from '../../payment/testing/world'
import { PayTab } from './pay-tab'
import { unfinishedView } from './unfinished'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
vi.mock('expo-symbols', () => ({ unstable_getMaterialSymbolSourceAsync: vi.fn(async () => ({ uri: 'icon.png' })) }))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const issue: Issue = {
  issuer: party(1).key,
  mint: MINT,
  lockSeq: 3,
  cumEnd: 5_000_000n,
  salt: new Uint8Array(16).fill(1),
  owner: { type: 'device', key: party(2).key },
  amount: 5_000_000n,
  caveats: { expiry: 2_000_000_000, hopsLeft: 3, flags: 0, scopeKind: 0, scope: new Uint8Array(20) },
}
const row = (state: 'prepared' | 'signed', id = 1) => ({
  messageId: new Uint8Array(32).fill(id),
  state,
  issueBody: encodeIssueBody(issue),
  ticket: new Uint8Array(161),
  bundle: state === 'signed' ? new Uint8Array(391) : null,
})

const props = (over: Partial<Parameters<typeof PayTab>[0]> = {}): Parameters<typeof PayTab>[0] => ({
  ready: true,
  allowance: 43_000_000n,
  symbol: 'USDC',
  decimals: 6,
  unfinished: [],
  onSetup: () => {},
  onScan: () => {},
  onPaste: () => {},
  onAddMoney: () => {},
  onResume: () => {},
  onDiscard: () => {},
  ...over,
})
const mount = async (over: Partial<Parameters<typeof PayTab>[0]> = {}) =>
  act(async () => create(<PayTab {...props(over)} />))
const texts = (root: ReactTestInstance) =>
  root.findAllByType('Text' as never).map((node) => [node.props.children].flat().join(''))
const has = (root: ReactTestInstance, testID: string) => root.findAll((node) => node.props.testID === testID).length > 0

describe('PayTab', () => {
  it('shows only setup-payments until the identity is ready', async () => {
    const renderer = await mount({ ready: false })
    expect(has(renderer.root, 'setup-payments')).toBe(true)
    for (const id of ['pay-scan', 'pay-paste', 'pay-allowance', 'pay-unfinished'])
      expect(has(renderer.root, id)).toBe(false)
  })

  it("shows the allowance from the payer's own locks and the Add money action when it is zero", async () => {
    const full = await mount()
    expect(texts(full.root)).toContain('You can pay up to 43.00 USDC without internet.')
    expect(has(full.root, 'pay-scan')).toBe(true)
    expect(has(full.root, 'pay-paste')).toBe(true)
    const none = await mount({ allowance: 0n })
    expect(texts(none.root)).toContain('Add money to pay without internet.')
    const onAddMoney = vi.fn()
    const empty = await mount({ allowance: 0n, onAddMoney })
    await act(async () => empty.root.findByProps({ testID: 'add-money' }).props.onPress())
    expect(onAddMoney).toHaveBeenCalled()
  })

  it('offers paying someone far away only when the screen exists', async () => {
    expect(has((await mount()).root, 'pay-far-away')).toBe(false)
    const onFarAway = vi.fn()
    const renderer = await mount({ onFarAway })
    await act(async () => renderer.root.findByProps({ testID: 'pay-far-away' }).props.onPress())
    expect(onFarAway).toHaveBeenCalled()
  })

  it('lists unfinished payments with Resume and Discard, and asks before it discards', async () => {
    const onResume = vi.fn()
    const onDiscard = vi.fn()
    const renderer = await mount({
      unfinished: [unfinishedView(row('prepared')), unfinishedView(row('signed', 2))],
      onResume,
      onDiscard,
    })
    const shown = texts(renderer.root).join('\n')
    expect(shown).toMatch(
      /Unfinished payment: 5\.00 USDC to phone [A-Z2-9]{4}-[A-Z2-9]{4}\. It was left before the other phone confirmed it\./,
    )
    expect(shown).toContain('Not confirmed: ask the other person whether it arrived.')
    const resume = renderer.root.findAll((node) => node.props.testID === 'pay-resume' && typeof node.type === 'string')
    expect(resume).toHaveLength(2)
    await act(async () => resume[0].props.onPress())
    expect(onResume).toHaveBeenCalledWith(new Uint8Array(32).fill(1))
    const discard = renderer.root.findAll(
      (node) => node.props.testID === 'pay-discard' && typeof node.type === 'string',
    )[0]
    await act(async () => discard.props.onPress())
    expect(onDiscard).not.toHaveBeenCalled()
    expect(texts(renderer.root).join('\n')).toContain('This part of your allowance may stay used.')
    await act(async () => renderer.root.findByProps({ testID: 'pay-discard-confirm' }).props.onPress())
    expect(onDiscard).toHaveBeenCalledWith(new Uint8Array(32).fill(1))
  })

  it('reads the amount and the other phone from the stored issue, and nothing else', () => {
    const view = unfinishedView(row('signed'))
    expect(view).toMatchObject({ amount: 5_000_000n, signed: true })
    expect(view.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  })
})
