import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { Reason } from '../../payment/reasons'
import type { Outcome } from '../../payment/receive'
import { AcceptedResult, RejectedResult } from './result'

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

const refusals = Object.values(Reason).filter((reason) => reason !== Reason.Accepted)
const limits = { window: 3600, max: 100_000_000n, symbol: 'USDC', decimals: 6 }

const accepted = (over: { duplicate?: boolean; requestedAmount?: bigint | null; keep?: boolean } = {}) =>
  ({
    accepted: true,
    duplicate: over.duplicate ?? false,
    messageId: new Uint8Array(32),
    note: {
      amount: 3_000_000n,
      requestedAmount: over.requestedAmount ?? 5_000_000n,
      keep: over.keep ?? false,
      liable: [{ device: new Uint8Array(33), lockSeq: 1, bond: 777_777_777n, attester: 1 }],
    },
  }) as unknown as Extract<Outcome, { accepted: true }>

describe('what the receiver says', () => {
  it('has a text for every reason and shows no number from a liability', async () => {
    for (const reason of refusals) {
      const root = await render(<RejectedResult reason={reason} limits={limits} onRetry={() => {}} onDone={() => {}} />)
      const shown = texts(root).join('\n')
      expect(shown).toContain('Not received.')
      expect(shown.length).toBeGreaterThan('Not received.'.length + 10)
      expect(shown).not.toContain('777')
      expect(shown).not.toContain('{')
    }
    const sentences: string[] = []
    for (const reason of refusals) {
      const root = await render(<RejectedResult reason={reason} limits={limits} onRetry={() => {}} onDone={() => {}} />)
      sentences.push(texts(root).join('\n'))
    }
    expect(new Set(sentences).size).toBe(refusals.length)
  })

  it('fills in this phone’s own limits, and says the window in words', async () => {
    const window = texts(
      await render(<RejectedResult reason={Reason.Window} limits={limits} onRetry={() => {}} onDone={() => {}} />),
    ).join('\n')
    expect(window).toContain('at least 1 hour.')
    const max = texts(
      await render(<RejectedResult reason={Reason.AboveMax} limits={limits} onRetry={() => {}} onDone={() => {}} />),
    ).join('\n')
    expect(max).toContain('more than the 100.00 USDC this phone accepts')
  })

  it('shows what arrived, what was asked when it differs, and the bond only as what is destroyed', async () => {
    const shown = texts(
      await render(<AcceptedResult outcome={accepted()} symbol="USDC" decimals={6} onDone={() => {}} />),
    ).join('\n')
    expect(shown).toContain('Received 3.00 USDC')
    expect(shown).toContain('You asked for 5.00 USDC; 3.00 USDC arrived.')
    expect(shown).toContain('destroyed if they sign the same money twice')
    expect(shown).not.toContain('777')
    const same = texts(
      await render(
        <AcceptedResult
          outcome={accepted({ requestedAmount: 3_000_000n })}
          symbol="USDC"
          decimals={6}
          onDone={() => {}}
        />,
      ),
    ).join('\n')
    expect(same).not.toContain('You asked for')
  })

  it('says a note kept for passing on can be passed on, and settles later', async () => {
    const shown = texts(
      await render(<AcceptedResult outcome={accepted({ keep: true })} symbol="USDC" decimals={6} onDone={() => {}} />),
    ).join('\n')
    expect(shown).toContain('You can pass it on')
    expect(shown).not.toContain("It's yours now. It will settle")
  })

  it('says a payment seen before was not added twice', async () => {
    const shown = texts(
      await render(
        <AcceptedResult outcome={accepted({ duplicate: true })} symbol="USDC" decimals={6} onDone={() => {}} />,
      ),
    ).join('\n')
    expect(shown).toContain('Already received. Nothing was added twice.')
  })
})
