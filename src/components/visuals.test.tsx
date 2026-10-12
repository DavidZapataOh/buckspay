import { act, type ReactElement } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { feedback } from '../feedback'
import { Chip } from './chip'
import { Hero } from './hero'
import { Info } from './info'
import { StepBar } from './step-bar'
import { Tile } from './tile'

vi.mock('react-native', () => import('../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#123456') : '#123456'),
}))
vi.mock('expo-symbols', () => ({ unstable_getMaterialSymbolSourceAsync: vi.fn(async () => ({ uri: 'icon.png' })) }))
vi.mock('../feedback', () => ({ feedback: { cue: vi.fn() } }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

async function render(element: ReactElement) {
  const tree = await act(async () => create(element))
  return tree
}
const find = (root: ReactTestInstance, type: string) => root.findAllByType(type as never)
const labels = (root: ReactTestInstance) =>
  find(root, 'Text').flatMap((node) => [node.props.children].flat() as string[])

beforeEach(() => vi.mocked(feedback.cue).mockClear())

describe('StepBar', () => {
  it('says which step of how many in a way a screen reader can use, and draws one segment per step', async () => {
    const { root } = await render(<StepBar total={4} current={1} />)
    const [bar] = find(root, 'View').filter((node) => node.props.accessibilityRole === 'progressbar')
    expect(bar.props.accessibilityLabel).toBe('Step 2 of 4')
    expect(bar.props.accessibilityValue).toEqual({ min: 1, max: 4, now: 2 })
    expect(find(bar, 'View').filter((node) => String(node.props.className).includes('flex-1'))).toHaveLength(4)
  })

  it('is quiet on first show and answers with a step cue each time the person moves forward', async () => {
    const tree = await render(<StepBar total={3} current={0} />)
    expect(feedback.cue).not.toHaveBeenCalled()
    await act(async () => tree.update(<StepBar total={3} current={1} />))
    expect(feedback.cue).toHaveBeenCalledExactlyOnceWith('step')
    await act(async () => tree.update(<StepBar total={3} current={0} />))
    expect(feedback.cue).toHaveBeenCalledTimes(1)
  })
})

describe('Hero', () => {
  it.each(['done', 'waiting', 'nearby', 'problem', 'scan'] as const)(
    'draws the %s scene with its meaning for screen readers',
    async (kind) => {
      const { root } = await render(<Hero kind={kind} label={`scene ${kind}`} />)
      const [scene] = find(root, 'View').filter((node) => node.props.accessibilityRole === 'image')
      expect(scene.props.accessibilityLabel).toBe(`scene ${kind}`)
    },
  )

  it('can be decorative when the title beside it already says everything', async () => {
    const { root } = await render(<Hero kind="done" decorative />)
    expect(find(root, 'View').some((node) => node.props.accessibilityRole === 'image')).toBe(false)
    expect(find(root, 'View').some((node) => node.props.importantForAccessibility === 'no-hide-descendants')).toBe(true)
  })
})

describe('Tile', () => {
  it('is one labelled button that answers a press with a tap cue and does the action', async () => {
    const onPress = vi.fn()
    const { root } = await render(<Tile icon="north_east" title="Pay" hint="Scan" onPress={onPress} testID="t" />)
    const [tile] = find(root, 'Pressable')
    expect(tile.props.accessibilityRole).toBe('button')
    expect(tile.props.accessibilityLabel).toBe('Pay. Scan')
    tile.props.onPress()
    expect(onPress).toHaveBeenCalledOnce()
    expect(feedback.cue).toHaveBeenCalledWith('tap')
  })

  it('takes the accent only when it is the main action, and is darker while pressed', async () => {
    const main = (await render(<Tile highlight icon="north_east" title="Pay" onPress={() => {}} />)).root
    const other = (await render(<Tile icon="south_west" title="Get paid" onPress={() => {}} />)).root
    expect(find(main, 'Pressable')[0].props.className).toContain('bg-primary')
    expect(find(main, 'Pressable')[0].props.className).toContain('active:bg-primary-pressed')
    expect(find(other, 'Pressable')[0].props.className).toContain('bg-surface')
    expect(find(other, 'Pressable')[0].props.className).not.toContain('bg-primary')
  })
})

describe('Chip', () => {
  it.each([
    ['done', 'bg-success-container', 'text-success'],
    ['waiting', 'bg-warning-container', 'text-warning'],
    ['problem', 'bg-danger-container', 'text-danger'],
    ['info', 'bg-secondary-container', 'text-on-secondary-container'],
  ] as const)('shows %s with a tinted container, an icon and a word', async (kind, container, text) => {
    const { root } = await render(<Chip kind={kind} label="Word" />)
    expect(find(root, 'View')[0].props.className).toContain(container)
    expect(find(root, 'Text')[0].props.className).toContain(text)
    expect(labels(root)).toContain('Word')
  })
})

describe('Info', () => {
  it('keeps the long text behind a button, and shows it in a sheet that closes', async () => {
    const { root } = await render(<Info title="Why" lines={['One.', 'Two.']} />)
    const modal = () => find(root, 'Modal')[0]
    expect(modal().props.visible).toBe(false)
    const open = find(root, 'Pressable').find((node) => node.props.accessibilityLabel === 'More info')!
    await act(async () => open.props.onPress())
    expect(modal().props.visible).toBe(true)
    expect(labels(root)).toEqual(expect.arrayContaining(['Why', 'One.', 'Two.']))
    const close = find(root, 'Pressable').find((node) => node.props.accessibilityLabel === 'Close')!
    await act(async () => close.props.onPress())
    expect(modal().props.visible).toBe(false)
  })
})
