import { describe, expect, it, vi } from 'vitest'
import { byLabel, mount, texts } from '../remote/ui-testing'
import { rewardsCopy } from './copy'
import type { RewardClaims } from './seams'
import type { NoteDb } from '../notes/db'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (name: string | string[]) => (Array.isArray(name) ? name.map(() => '#000000') : '#000000'),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
vi.mock('expo-linking', () => ({ openURL: vi.fn() }))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }
})
vi.mock('../network/use-network', () => ({ useNetwork: () => ({ getExplorerUrl: (path: string) => path }) }))

const state: { db?: NoteDb; claims?: RewardClaims } = {}
vi.mock('../payment/payments-provider', () => ({ usePayments: () => ({ db: state.db }) }))
vi.mock('./use-reward-claims', () => ({ useRewardClaims: () => state.claims }))

const { default: RewardsRoute } = await import('../../app/activity/rewards')

const leaf = { kind: 'leaf', state: 'unclaimed', exp: 1, unit: 490_000n } as const
const shown = (r: Awaited<ReturnType<typeof mount>>) => texts(r.root).join('\n')

describe('the rewards route', () => {
  it('offers Claim when the phone holds leaves it can claim', async () => {
    state.db = createNodeDb()
    await migrate(state.db)
    state.claims = { leaves: async () => [leaf], claim: vi.fn(), move: vi.fn() }
    const r = await mount(<RewardsRoute />)
    expect(byLabel(r.root, 'Claim')).toBeDefined()
  })

  it('offers Move when a reward was claimed', async () => {
    state.db = createNodeDb()
    await migrate(state.db)
    state.claims = { leaves: async () => [{ ...leaf, state: 'claimed' }], claim: vi.fn(), move: vi.fn() }
    const r = await mount(<RewardsRoute />)
    expect(byLabel(r.root, 'Move to my wallet')).toBeDefined()
  })

  it('shows the rewards it has stored, without claims, when the claim store is not available', async () => {
    state.db = createNodeDb()
    await migrate(state.db)
    state.claims = undefined
    const r = await mount(<RewardsRoute />)
    expect(shown(r)).toContain(rewardsCopy.empty)
    expect(byLabel(r.root, 'Claim')).toBeUndefined()
  })

  it('is loading, not empty, until the store is open', async () => {
    state.db = undefined
    state.claims = undefined
    const r = await mount(<RewardsRoute />)
    expect(shown(r)).toContain(rewardsCopy.loading)
    expect(shown(r)).not.toContain(rewardsCopy.empty)
  })

  it('says why the rewards could not be read instead of showing them empty', async () => {
    state.db = createNodeDb()
    await migrate(state.db)
    state.claims = {
      leaves: async () => {
        throw new Error('disk full')
      },
      claim: vi.fn(),
      move: vi.fn(),
    }
    const r = await mount(<RewardsRoute />)
    expect(shown(r)).toContain('disk full')
    expect(shown(r)).not.toContain(rewardsCopy.empty)
  })
})
