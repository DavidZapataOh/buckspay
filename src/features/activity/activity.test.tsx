import { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { ActivityRow } from '../notes/activity'
import { ActivityList } from './activity'
import { activityId, parseActivityId, sentence } from './format'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
  var IS_REACT_NATIVE_TEST_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_NATIVE_TEST_ENVIRONMENT = true

const key = (n: number) => Uint8Array.of(2, ...new Uint8Array(32).fill(n))
const NOW = Date.UTC(2026, 9, 5, 15) / 1000
const row = (over: Partial<ActivityRow>): ActivityRow => ({
  id: new Uint8Array(32).fill(1),
  kind: 'paid',
  amount: 5_000_000n,
  state: 'confirmed',
  at: NOW - 60,
  counterparty: key(2),
  memo: null,
  reason: null,
  ...over,
})
const texts = (root: ReactTestInstance) =>
  root.findAllByType('Text' as never).map((node) => [node.props.children].flat().join(''))

describe('ActivityList', () => {
  it('lists payments and received notes newest first with their words', async () => {
    const rows = [
      row({ kind: 'received', state: 'settled', id: new Uint8Array(32).fill(2), at: NOW - 10 }),
      row({ kind: 'paid', state: 'signed', id: new Uint8Array(32).fill(3), at: NOW - 100 }),
      row({ kind: 'paid', state: 'rejected', reason: 11, id: new Uint8Array(32).fill(4), at: NOW - 200 }),
      row({ kind: 'paid', state: 'abandoned', id: new Uint8Array(32).fill(5), at: NOW - 300 }),
      row({ kind: 'received', state: 'held', id: new Uint8Array(32).fill(6), at: NOW - 86_400 * 2 }),
    ]
    const renderer = await act(async () =>
      create(<ActivityList rows={rows} symbol="USDC" decimals={6} now={NOW} onOpen={() => {}} />),
    )
    const shown = texts(renderer.root)
    const lines = shown.filter((line) => line.includes('USDC'))
    expect(lines[0]).toBe('Received 5.00 USDC · Settled')
    expect(lines[1]).toMatch(/^Paid 5\.00 USDC · phone [A-Z2-9]{4}-[A-Z2-9]{4} · Not confirmed$/)
    expect(lines[2]).toMatch(/· Refused$/)
    expect(lines[3]).toMatch(/· Cancelled$/)
    expect(lines[4]).toBe('Received 5.00 USDC · Received')
    expect(shown).toContain('Today')
  })

  it('says what became of a note: passed on, being sent, change', async () => {
    const rows = [
      row({ kind: 'received', state: 'spent', id: new Uint8Array(32).fill(2), at: NOW - 10 }),
      row({ kind: 'received', state: 'spending', id: new Uint8Array(32).fill(3), at: NOW - 20 }),
      row({ kind: 'received', state: 'change', id: new Uint8Array(32).fill(4), at: NOW - 30 }),
    ]
    const renderer = await act(async () =>
      create(<ActivityList rows={rows} symbol="USDC" decimals={6} now={NOW} onOpen={() => {}} />),
    )
    const lines = texts(renderer.root).filter((line) => line.includes('USDC'))
    expect(lines.map((line) => line.split(' · ').pop())).toEqual(['Passed on', 'Sending…', 'Change'])
  })

  it('says there is nothing yet when there are no rows', async () => {
    const renderer = await act(async () =>
      create(<ActivityList rows={[]} symbol="USDC" decimals={6} now={NOW} onOpen={() => {}} />),
    )
    expect(texts(renderer.root)).toContain('No payments yet.')
  })

  it('opens the row that was tapped', async () => {
    const onOpen = vi.fn()
    const renderer = await act(async () =>
      create(<ActivityList rows={[row({})]} symbol="USDC" decimals={6} now={NOW} onOpen={onOpen} />),
    )
    const press = renderer.root.findAll(
      (node) => node.props.accessibilityRole === 'button' && typeof node.type === 'string',
    )[0]
    await act(async () => press.props.onPress())
    expect(onOpen).toHaveBeenCalledWith(activityId(row({})))
  })

  it('never renders a bond, a balance of another person or a coordinate', async () => {
    const rows = [row({ kind: 'received', state: 'held', memo: 'Coffee' })]
    const renderer = await act(async () =>
      create(<ActivityList rows={rows} symbol="USDC" decimals={6} now={NOW} onOpen={() => {}} />),
    )
    const shown = texts(renderer.root).join('\n').toLowerCase()
    for (const word of ['bond', 'balance', 'latitude', 'longitude', 'location']) expect(shown).not.toContain(word)
    expect(Object.keys(rows[0]).sort()).toEqual([
      'amount',
      'at',
      'counterparty',
      'id',
      'kind',
      'memo',
      'reason',
      'state',
    ])
  })
})

describe('activity ids', () => {
  it('round-trip, and say which table a row is from', () => {
    const id = activityId(row({ kind: 'received', id: new Uint8Array(32).fill(0xab) }))
    expect(id).toBe(`received-${'ab'.repeat(32)}`)
    expect(parseActivityId(id)).toEqual({ kind: 'received', id: new Uint8Array(32).fill(0xab) })
    expect(parseActivityId('nonsense')).toBeUndefined()
    expect(parseActivityId(`paid-${'zz'.repeat(32)}`)).toBeUndefined()
  })

  it('make the sentence of a row from its words, never from anyone else’s figures', () => {
    expect(sentence(row({}), 'USDC', 6)).toMatch(/^Paid 5\.00 USDC · phone [A-Z2-9]{4}-[A-Z2-9]{4} · Confirmed$/)
    expect(sentence(row({ kind: 'received', state: 'conflicted' }), 'USDC', 6)).toContain('Not paid')
  })
})
