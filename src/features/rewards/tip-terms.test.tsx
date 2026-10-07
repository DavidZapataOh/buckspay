import { act, useEffect } from 'react'
import { create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAsyncStorage } from '../../test-support/async-storage'
import { MIN_TIP_BOND } from './copy'
import { usePaywordSigner } from './seams'
import { useTipTerms } from './use-tip-terms'
import { useTipping } from './use-tipping'

const mocks = vi.hoisted(() => ({
  identity: { deviceKey: undefined as { publicKey: Uint8Array } | undefined },
  bonds: [] as bigint[],
  wallet: { client: { rpc: {} } },
}))

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('@react-native-async-storage/async-storage', () => import('../../test-support/async-storage'))
vi.mock('@wallet-ui/react-native-kit', () => ({ useMobileWallet: () => mocks.wallet }))
vi.mock('../../keys', () => ({ signPayword: async () => new Uint8Array(64) }))
vi.mock('../identity/use-device-identity', () => ({ useDeviceIdentity: () => mocks.identity }))
vi.mock('../attesters/tickets', () => ({
  loadTickets: async () => new Map(mocks.bonds.map((bond, index) => [index, { bond }])),
}))
vi.mock('./reward-terms', async (original) => ({
  ...(await original<typeof import('./reward-terms')>()),
  readMintTerms: async () => ({ unit: 1_000_000n, wordValue: 500_000n }),
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Seen = {
  signer: ReturnType<typeof usePaywordSigner>
  terms: ReturnType<typeof useTipTerms>
  tipping: ReturnType<typeof useTipping>
}
const seen: Seen[] = []
function Probe() {
  const signer = usePaywordSigner()
  const terms = useTipTerms()
  const tipping = useTipping(terms)
  useEffect(() => {
    seen.push({ signer, terms, tipping })
  })
  return null
}
const mount = async () => {
  await act(async () => {
    create(<Probe />)
  })
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
  return seen[seen.length - 1]!
}

describe('the tip terms with the device key', () => {
  beforeEach(() => {
    seen.length = 0
    resetAsyncStorage()
    mocks.identity.deviceKey = { publicKey: new Uint8Array(33).fill(2) }
    mocks.bonds = []
  })

  it('offers the tip switch and the review tip when the bond covers a channel', async () => {
    mocks.bonds = [MIN_TIP_BOND]
    const last = await mount()
    expect(last.terms).toEqual({ wordValue: 500_000n, bond: MIN_TIP_BOND })
    expect(last.tipping.settings?.bond).toBe(MIN_TIP_BOND)
    expect(last.tipping.tip).toEqual({ value: 500_000n })
  })

  it('shows the switch but no tip when the bond is below a channel', async () => {
    mocks.bonds = [MIN_TIP_BOND - 1n]
    const last = await mount()
    expect(last.tipping.settings?.bond).toBe(MIN_TIP_BOND - 1n)
    expect(last.tipping.tip).toBeUndefined()
  })

  it('keeps the same signer across renders', async () => {
    mocks.bonds = [MIN_TIP_BOND]
    await mount()
    const signers = new Set(seen.map(({ signer }) => signer))
    expect(seen.length).toBeGreaterThan(1)
    expect(signers.size).toBe(1)
    expect(typeof [...signers][0]).toBe('function')
  })

  it('offers nothing without a device key', async () => {
    mocks.identity.deviceKey = undefined
    mocks.bonds = [MIN_TIP_BOND]
    const last = await mount()
    expect(last.signer).toBeUndefined()
    expect(last.terms).toBeUndefined()
    expect(last.tipping.settings).toBeUndefined()
  })
})
