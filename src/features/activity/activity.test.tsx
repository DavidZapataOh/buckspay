import { act, type ReactElement } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { ActivityRow } from '../notes/activity'
import { ActivityList } from './activity'
import { activityId, parseActivityId, sentence } from './format'

const { push } = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('expo-router', () => ({ router: { push } }))
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

const mount = async (element: ReactElement) => act(async () => create(element))

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
    const lines = shown.filter((line) =>
      /^(Paid|Received|Credited|Not confirmed|Refused|Cancelled|Received|[+−]\d+\.\d\d)$/.test(line),
    )
    expect(lines).toEqual([
      'Received',
      'Credited',
      '+5.00',
      'Paid',
      'Not confirmed',
      '−5.00',
      'Paid',
      'Refused',
      '−5.00',
      'Paid',
      'Cancelled',
      '−5.00',
      'Received',
      'Received',
      '+5.00',
    ])
    expect(shown.join('\n')).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}/)
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
    const lines = texts(renderer.root).filter((line) => ['Passed on', 'Sending…', 'Change'].includes(line))
    expect(lines).toEqual(['Passed on', 'Sending…', 'Change'])
  })

  it('says there is nothing yet when there are no rows', async () => {
    const renderer = await act(async () =>
      create(<ActivityList rows={[]} symbol="USDC" decimals={6} now={NOW} onOpen={() => {}} />),
    )
    expect(texts(renderer.root)).toContain('No payments yet')
  })

  it('opens the row that was tapped', async () => {
    const onOpen = vi.fn()
    const renderer = await act(async () =>
      create(<ActivityList rows={[row({})]} symbol="USDC" decimals={6} now={NOW} onOpen={onOpen} />),
    )
    const press = renderer.root.findAll(
      (node) =>
        node.props.accessibilityRole === 'button' &&
        typeof node.type === 'string' &&
        !String(node.props.testID).endsWith('-entry'),
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

  it('says how far a held note went through phones nearby', () => {
    const words = (state: string, handedTo?: number) => sentence(row({ kind: 'received', state, handedTo }), 'USDC', 6)
    expect(words('relay-waiting')).toContain('Waiting for a phone with internet')
    expect(words('relay-handed', 1)).toContain('Handed to 1 phone nearby')
    expect(words('relay-handed', 3)).toContain('Handed to 3 phones nearby')
    expect(words('relay-sent')).toContain('Sent')
  })

  it('opens rewards from its own row, with what is ready, and only when it is given', async () => {
    const onOpen = vi.fn()
    const none = await mount(<ActivityList rows={[]} symbol="USDC" decimals={6} now={NOW} onOpen={vi.fn()} />)
    expect(texts(none.root)).not.toContain('Rewards')
    const r = await mount(
      <ActivityList
        rows={[]}
        symbol="USDC"
        decimals={6}
        now={NOW}
        onOpen={vi.fn()}
        rewards={{ summary: '0.98 USDC ready to claim', onOpen }}
      />,
    )
    expect(texts(r.root)).toContain('Rewards')
    expect(texts(r.root)).toContain('0.98 USDC ready to claim')
    const entry = r.root.findByProps({ accessibilityLabel: 'Rewards: 0.98 USDC ready to claim' })
    expect(entry.props.accessibilityRole).toBe('button')
    await act(async () => entry.props.onPress())
    expect(onOpen).toHaveBeenCalledOnce()
  })
})

describe('netting entries', () => {
  it('shows_the_debts_and_net_debts_entries_under_the_title_and_opens_them', async () => {
    const renderer = await mount(<ActivityList rows={[]} symbol="USDC" decimals={6} now={NOW} onOpen={() => {}} />)
    const find = (id: string) => renderer.root.findAll((n) => n.props.testID === id && typeof n.type === 'string')[0]
    const [debts, netting] = [find('debts-entry'), find('netting-entry')]
    expect(debts.props.accessibilityLabel).toBe('Debts')
    expect(netting.props.accessibilityLabel).toBe('Cancel debts with friends')
    expect(String(debts.props.className)).toMatch(/min-h-14/)
    await act(async () => {
      debts.props.onPress()
      netting.props.onPress()
    })
    expect(push.mock.calls.map((c) => c[0])).toEqual(['/debts', '/debts/netting'])
  })

  it('keeps_the_existing_rows_after_the_two_entries', async () => {
    const renderer = await mount(
      <ActivityList rows={[row({})]} symbol="USDC" decimals={6} now={NOW} onOpen={() => {}} />,
    )
    expect(texts(renderer.root)).toEqual(expect.arrayContaining(['Paid', '−5.00']))
  })
})
