import { describe, expect, it, vi } from 'vitest'
import { mount, press, texts } from '../remote/ui-testing'

const back = vi.fn()
const status = { name: 'running' as const }
const pairing = { status, confirming: undefined, deadline: 0, peers: [], tag: 'A1B2', pick: vi.fn() }

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('uniwind', () => ({
  useCSSVariable: (n: string | string[]) => (Array.isArray(n) ? n.map(() => '#000000') : '#000000'),
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
vi.mock('expo-router', () => ({ router: { back: () => back() } }))
vi.mock('./use-pairing', () => ({ usePairing: () => pairing }))
vi.mock('../receive/use-seconds-left', () => ({ useSecondsLeft: () => 0 }))

const { PairingScreen } = await import('./pairing-screen')

describe('the pairing screen', () => {
  it.each(['payer', 'receiver'] as const)('lets the %s leave while it searches or waits', async (role) => {
    const r = await mount(<PairingScreen role={role} />)
    expect(texts(r.root).length).toBeGreaterThan(0)
    await press(r.root, 'Cancel')
    expect(back).toHaveBeenCalled()
    back.mockClear()
  })
})
