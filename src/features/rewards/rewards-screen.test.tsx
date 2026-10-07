import { describe, expect, it, vi } from 'vitest'
import { byLabel, mount, press, texts } from '../remote/ui-testing'
import { rewardsCopy } from './copy'
import { RewardsScreen } from './rewards-screen'
import type { RewardRecord } from './state'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))

const word = (state: 'held' | 'rejected', reason?: 'not_delivered' | 'not_added'): RewardRecord => ({
  kind: 'word',
  state,
  value: 490_000n,
  reason,
})
const leaf = (state: 'unclaimed' | 'claiming' | 'claimed', exp: number, signature?: string): RewardRecord => ({
  kind: 'leaf',
  state,
  exp,
  unit: 490_000n,
  signature,
})
const mixed = [
  word('held'),
  leaf('unclaimed', 1),
  leaf('claiming', 0),
  leaf('claimed', 0, 'sig1'),
  word('rejected', 'not_delivered'),
]
const base = { symbol: 'USDC', decimals: 6 }
const shown = (r: Awaited<ReturnType<typeof mount>>) => texts(r.root).join('\n')

describe('RewardsScreen', () => {
  it('shows each state with the amounts, and no forbidden word', async () => {
    const r = await mount(<RewardsScreen {...base} rows={mixed} onClaim={vi.fn()} onMove={vi.fn()} />)
    const all = shown(r)
    expect(all).toContain('Ready to claim · 0.98 USDC')
    expect(all).toContain('Delivered a payment · fee 0.49 USDC, waiting to be paid in')
    expect(all).toContain('Claiming to a new address')
    expect(all).toContain('Claimed · 0.49 USDC to a new address')
    expect(all).toContain('Not paid: the payment was not delivered')
    for (const banned of [/private payment/i, /anonymous/i, /untraceable/i, /bounded loss/i])
      expect(all).not.toMatch(banned)
  })

  it('says the trust limits once, also when there is nothing yet', async () => {
    const r = await mount(<RewardsScreen {...base} rows={[]} />)
    const all = shown(r)
    expect(all).toContain(rewardsCopy.trust)
    expect(all).toMatch(/not that you carried the payment/)
    expect(all).toMatch(/phones that pass it along get nothing/)
    expect(all).toContain(rewardsCopy.empty)
  })

  it('does not show an empty state while the rewards are loading', async () => {
    const r = await mount(<RewardsScreen {...base} rows={undefined} />)
    expect(shown(r)).not.toContain(rewardsCopy.empty)
    expect(shown(r)).toContain(rewardsCopy.loading)
  })

  it('claim asks first, states what the service sees and delays by default', async () => {
    const onClaim = vi.fn(async () => {})
    const r = await mount(<RewardsScreen {...base} rows={[leaf('unclaimed', 0)]} onClaim={onClaim} onMove={vi.fn()} />)
    await press(r.root, 'Claim')
    expect(onClaim).not.toHaveBeenCalled()
    expect(shown(r)).toMatch(/sees your network address/)
    expect(shown(r)).not.toMatch(/private/i)
    await press(r.root, 'Claim to a new address')
    expect(onClaim).toHaveBeenCalledExactlyOnceWith({ immediate: false })
    expect(shown(r)).toContain(rewardsCopy.claimScheduled)
  })

  it('claim now is explicit and says it is easier to link', async () => {
    const onClaim = vi.fn(async () => {})
    const r = await mount(<RewardsScreen {...base} rows={[leaf('unclaimed', 0)]} onClaim={onClaim} onMove={vi.fn()} />)
    await press(r.root, 'Claim')
    expect(shown(r)).toContain(rewardsCopy.claimNowNote)
    await press(r.root, 'Claim now')
    expect(onClaim).toHaveBeenCalledExactlyOnceWith({ immediate: true })
  })

  it('surfaces a failed claim and keeps the confirmation open', async () => {
    const onClaim = vi.fn(async () => {
      throw new Error('gateway unreachable')
    })
    const r = await mount(<RewardsScreen {...base} rows={[leaf('unclaimed', 0)]} onClaim={onClaim} onMove={vi.fn()} />)
    await press(r.root, 'Claim')
    await press(r.root, 'Claim to a new address')
    expect(shown(r)).toContain('Couldn’t claim. gateway unreachable')
    expect(byLabel(r.root, 'Claim to a new address')).toBeDefined()
  })

  it('move warns that it links the rewards before sending', async () => {
    const onMove = vi.fn(async () => {})
    const r = await mount(
      <RewardsScreen {...base} rows={[leaf('claimed', 0, 'sig')]} onClaim={vi.fn()} onMove={onMove} />,
    )
    await press(r.root, 'Move to my wallet')
    expect(shown(r)).toMatch(/links these rewards to that wallet/)
    expect(onMove).not.toHaveBeenCalled()
    await press(r.root, 'Move anyway')
    expect(onMove).toHaveBeenCalledOnce()
  })

  it('surfaces a failed move', async () => {
    const onMove = vi.fn(async () => {
      throw new Error('offline')
    })
    const r = await mount(<RewardsScreen {...base} rows={[leaf('claimed', 0)]} onClaim={vi.fn()} onMove={onMove} />)
    await press(r.root, 'Move to my wallet')
    await press(r.root, 'Move anyway')
    expect(shown(r)).toContain('Couldn’t move the rewards. offline')
  })

  it('offers no claim when nothing is ready or claiming is unavailable', async () => {
    const none = await mount(<RewardsScreen {...base} rows={[word('held')]} onClaim={vi.fn()} onMove={vi.fn()} />)
    expect(byLabel(none.root, 'Claim')).toBeUndefined()
    const unavailable = await mount(<RewardsScreen {...base} rows={[leaf('unclaimed', 0)]} />)
    expect(byLabel(unavailable.root, 'Claim')).toBeUndefined()
  })

  it('opens the explorer for a claimed reward', async () => {
    const onOpenSignature = vi.fn()
    const r = await mount(
      <RewardsScreen
        {...base}
        rows={[leaf('claimed', 0, 'sigX')]}
        onClaim={vi.fn()}
        onMove={vi.fn()}
        onOpenSignature={onOpenSignature}
      />,
    )
    await press(r.root, 'View claim on the explorer')
    expect(onOpenSignature).toHaveBeenCalledWith('sigX')
  })
})
