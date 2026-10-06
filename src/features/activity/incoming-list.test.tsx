import { describe, expect, it, vi } from 'vitest'
import { mount, texts } from '../remote/ui-testing'
import { IncomingList } from './incoming-list'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))

describe('incoming from far away', () => {
  it('lists each settlement with its amount and says nothing it does not know', async () => {
    const r = await mount(
      <IncomingList
        items={[{ signature: 'a', amount: 3_000_000n, from: new Uint8Array(33), at: 1_800_000_000 }]}
        symbol="USDC"
        decimals={6}
      />,
    )
    expect(texts(r.root)[0]).toBe('Received 3.00 USDC · From someone far away')
  })
  it('shows nothing when nothing came', async () => {
    const r = await mount(<IncomingList items={[]} symbol="USDC" decimals={6} />)
    expect(texts(r.root)).toEqual([])
  })
})
