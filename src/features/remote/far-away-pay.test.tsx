import { describe, expect, it, vi } from 'vitest'
import { remoteCopy } from './copy'
import { FarAwayPay } from './far-away-pay'
import { M, W } from './testing'
import { byLabel, mount, press, texts, type } from './ui-testing'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))

const ana = (check: 'verified' | 'no-account' | 'not-checked' = 'verified') => [
  { name: 'Ana', wallet: W, mint: M, check },
]
const shown = (renderer: Awaited<ReturnType<typeof mount>>) => texts(renderer.root).join('\n')

describe('Far away pay', () => {
  it('shows the deadline before confirming and the honest outcome line', async () => {
    const r = await mount(<FarAwayPay contacts={ana()} now={1_800_000_000} online={false} />)
    await press(r.root, 'Ana')
    await type(r.root, remoteCopy.amount, '3')
    await press(r.root, remoteCopy.review)
    expect(shown(r)).toMatch(/Ana gets 3\.00 USDC/)
    expect(shown(r)).toMatch(/stays yours/)
    expect(shown(r)).toContain(remoteCopy.offlineNote)
  })
  it('warns when an undelivered payment to the same contact exists', async () => {
    const r = await mount(<FarAwayPay contacts={ana()} pendingTo={[W]} now={1} online={false} />)
    await press(r.root, 'Ana')
    expect(texts(r.root)).toContain(remoteCopy.pendingWarning)
  })
  it('confirms with the contact and the amount in base units', async () => {
    const calls: [string, bigint][] = []
    const r = await mount(
      <FarAwayPay
        contacts={ana()}
        now={1}
        online
        onConfirm={(contact, amount) => calls.push([contact.name, amount])}
      />,
    )
    await press(r.root, 'Ana')
    await type(r.root, remoteCopy.amount, '3.5')
    await press(r.root, remoteCopy.review)
    await press(r.root, remoteCopy.confirm)
    expect(calls).toEqual([['Ana', 3_500_000n]])
  })
  it('does not let a contact without a USDC account be paid', async () => {
    const r = await mount(<FarAwayPay contacts={ana('no-account')} now={1} online />)
    await press(r.root, 'Ana')
    expect(texts(r.root)).toContain(remoteCopy.noAccount)
    await type(r.root, remoteCopy.amount, '3')
    expect(byLabel(r.root, remoteCopy.review).props.accessibilityState.disabled).toBe(true)
  })
  it('shows not checked and the cost of failure for an unchecked contact', async () => {
    const r = await mount(<FarAwayPay contacts={ana('not-checked')} now={1} online={false} />)
    await press(r.root, 'Ana')
    expect(texts(r.root)).toContain(remoteCopy.notChecked)
  })
})
