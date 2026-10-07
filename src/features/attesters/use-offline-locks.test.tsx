import { act, useEffect } from 'react'
import { create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MINT, makeTicket } from '../../payment/testing/world'
import { resetAsyncStorage } from '../../test-support/async-storage'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { saveTickets } from './tickets'
import { useOfflineLocks } from './use-offline-locks'

const mocks = vi.hoisted(() => ({
  chain: undefined as unknown,
  db: undefined as unknown,
  locks: { locks: undefined as unknown, refresh: async () => {} },
  identity: { deviceKey: { publicKey: new Uint8Array(33).fill(2) } },
}))

vi.mock('react-native', () => import('../../test-support/react-native'))
vi.mock('@react-native-async-storage/async-storage', () => import('../../test-support/async-storage'))
vi.mock('../lock/use-locks', () => ({ useLocks: () => mocks.locks }))
vi.mock('../lock/build-funding', () => ({ BUILD_FUNDING_MINT: 'FundingMint' }))
vi.mock('../identity/use-device-identity', () => ({
  useDeviceIdentity: () => mocks.identity,
}))
vi.mock('../payment/payments-provider', () => ({
  nowSeconds: () => Math.floor(Date.now() / 1000),
  usePayments: () => ({ db: mocks.db }),
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const key = new Uint8Array(33).fill(2)
const FAR = 4_000_000_000
const lock = (lockSeq: number, withdrawn = false) => ({ lockSeq, mint: 'FundingMint', withdrawn })
const seen: { current?: ReturnType<typeof useOfflineLocks> } = {}
function Probe() {
  const current = useOfflineLocks()
  useEffect(() => {
    seen.current = current
  })
  return null
}
const mount = async () => {
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(<Probe />)
  })
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
  return tree
}

describe('the offline allowance without a read of the chain', () => {
  beforeEach(async () => {
    resetAsyncStorage()
    mocks.db = createNodeDb()
    await migrate(mocks.db as never)
    await saveTickets(key, [
      makeTicket({
        device: key,
        mint: MINT,
        lockSeq: 3,
        bond: 200_000_000n,
        backing: 100_000_000n,
        lockUntil: FAR,
        validUntil: FAR,
      }),
    ])
  })

  it('stays after a start that cannot read the chain, once a read has shown the lock', async () => {
    mocks.locks.locks = [lock(3)]
    await (await mount()).unmount()
    mocks.locks.locks = undefined
    await mount()
    expect(seen.current?.allowance()).toBe(100_000_000n)
  })

  it('is empty when no read has ever shown a lock', async () => {
    mocks.locks.locks = undefined
    await mount()
    expect(seen.current?.allowance()).toBe(0n)
  })

  it('goes when a read shows the lock withdrawn', async () => {
    mocks.locks.locks = [lock(3)]
    await (await mount()).unmount()
    mocks.locks.locks = [lock(3, true)]
    await (await mount()).unmount()
    mocks.locks.locks = undefined
    await mount()
    expect(seen.current?.allowance()).toBe(0n)
  })
})
