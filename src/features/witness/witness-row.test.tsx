import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { witnessCopy } from './copy'
import { NearbyCheckSettings } from './nearby-check-settings'
import type { WitnessPolicy } from './policy'
import { WitnessRow } from './witness-row'
import {
  initialWitnessState,
  MAX_ATTEMPTS,
  type WitnessEvent,
  witnessReducer,
  type WitnessState,
} from './witness-state'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('expo-symbols', () => ({ unstable_getMaterialSymbolSourceAsync: vi.fn(async () => ({ uri: 'icon.png' })) }))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const texts = (root: ReactTestInstance) =>
  root.findAllByType('Text' as never).map((node) => [node.props.children].flat().join(''))
const render = async (element: React.ReactElement) => (await act(async () => create(element))).root
const stateAfter = (...events: WitnessEvent[]): WitnessState => events.reduce(witnessReducer, initialWitnessState)
const noop = () => {}

const row = (
  role: 'payer' | 'receiver',
  policy: WitnessPolicy,
  state: WitnessState,
  over: Partial<Parameters<typeof WitnessRow>[0]> = {},
) =>
  render(
    <WitnessRow
      role={role}
      policy={policy}
      state={state}
      onSkip={noop}
      onRetry={noop}
      onContinue={noop}
      onMeaning={noop}
      onOpenSettings={noop}
      {...over}
    />,
  )

const start = (policy: WitnessPolicy): WitnessEvent => ({ type: 'start', policy })
const result = (status: 'seen' | 'not-seen' | 'unavailable'): WitnessEvent => ({
  type: 'result',
  result: { status, evidence: status === 'seen' ? new Uint8Array(176) : undefined },
})

describe('the nearby check row', () => {
  it('shows the sentence of each state', async () => {
    const checking = stateAfter(start('auto'))
    expect(texts(await row('receiver', 'auto', checking))).toContain(witnessCopy.receiverChecking)
    expect(texts(await row('payer', 'auto', checking))).toContain(witnessCopy.payerChecking)
    expect(texts(await row('receiver', 'auto', stateAfter(start('auto'), result('seen'))))).toContain(witnessCopy.seen)
    expect(texts(await row('receiver', 'auto', stateAfter(start('auto'), result('not-seen'))))).toContain(
      witnessCopy.notSeen,
    )
    expect(texts(await row('receiver', 'auto', stateAfter(start('auto'), result('unavailable'))))).toContain(
      witnessCopy.unavailable,
    )
    expect(texts(await row('receiver', 'auto', stateAfter(start('auto'), { type: 'skip' })))).toContain(
      witnessCopy.skipped,
    )
  })

  it('renders nothing when the check is off', async () => {
    const root = await row('receiver', 'off', initialWitnessState)
    expect(root.findAllByProps({ testID: 'witness-row' })).toHaveLength(0)
  })

  it('announces a change of state as a live region', async () => {
    const root = await row('receiver', 'auto', stateAfter(start('auto'), result('seen')))
    expect(root.findByProps({ testID: 'witness-row' }).props.accessibilityLiveRegion).toBe('polite')
  })

  it('offers Try again only while attempts remain', async () => {
    const has = (root: ReactTestInstance) => root.findAllByProps({ testID: 'witness-retry' }).length > 0
    expect(has(await row('receiver', 'auto', stateAfter(start('auto'), result('not-seen'))))).toBe(true)
    let state = stateAfter(start('auto'))
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      state = [result('not-seen'), { type: 'retry' } as WitnessEvent].reduce(witnessReducer, state)
    }
    state = witnessReducer(state, result('not-seen'))
    expect(has(await row('receiver', 'auto', state))).toBe(false)
  })

  it('holds the required headline until the check is seen or Continue anyway is pressed', async () => {
    const required = stateAfter(start('require'))
    expect(texts(await row('receiver', 'require', required))).toContain(witnessCopy.requiredChecking)
    const missed = witnessReducer(required, result('not-seen'))
    expect(texts(await row('receiver', 'require', missed))).toContain(witnessCopy.requiredNotSeen)
    const continued = witnessReducer(missed, { type: 'continue' })
    expect(texts(await row('receiver', 'require', continued))).toContain(witnessCopy.notSeen)
    expect(texts(await row('payer', 'require', missed))).toContain(witnessCopy.notSeen)
  })

  it('calls back for each button', async () => {
    const [onRetry, onContinue] = [vi.fn(), vi.fn()]
    const missed = stateAfter(start('require'), result('not-seen'))
    const root = await row('receiver', 'require', missed, { onRetry, onContinue })
    await act(async () => root.findByProps({ testID: 'witness-retry' }).props.onPress())
    await act(async () => root.findByProps({ testID: 'witness-continue' }).props.onPress())
    expect([onRetry, onContinue].map((fn) => fn.mock.calls.length)).toEqual([1, 1])
  })

  it('contains no word from the forbidden list', () => {
    const sentences = (value: unknown): string[] =>
      typeof value === 'string' ? [value] : Object.values(value as object).flatMap(sentences)
    for (const sentence of sentences(witnessCopy)) {
      expect(sentence.toLowerCase()).not.toMatch(/verified|proof|confirmed|secure|present|inaudible/)
    }
  })

  it('lays out the switches and the amount of the settings', async () => {
    const onAsk = vi.fn()
    const root = await render(
      <NearbyCheckSettings
        answer
        ask={false}
        audible={false}
        requireFrom="20"
        onAnswer={noop}
        onAsk={onAsk}
        onAudible={noop}
        onRequireFrom={noop}
      />,
    )
    expect(texts(root)).toEqual(
      expect.arrayContaining([witnessCopy.settings.answer, witnessCopy.settings.ask, witnessCopy.settings.footnote]),
    )
    root.findAllByType('Switch' as never)[1].props.onValueChange(true)
    expect(onAsk).toHaveBeenCalledWith(true)
  })
})
