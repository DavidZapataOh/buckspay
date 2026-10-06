import { describe, expect, it, vi } from 'vitest'
import { DEVNET_GENESIS_HASH } from '../../protocol'
import { PINNED_GATEWAY_KEYS } from '../../protocol/hpke'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { syncBeacon } from './beacon-sync'
import { loadConfig } from './config'

const NOW = PINNED_GATEWAY_KEYS[0].notBefore + 100
const listed = PINNED_GATEWAY_KEYS.map((key) => ({
  keyId: key.keyId,
  publicKey: btoa(String.fromCharCode(...key.publicKey)),
}))

async function setup(validated: boolean, fetchConfig = vi.fn(async () => ({ keys: listed }))) {
  const db = createNodeDb()
  await migrate(db)
  const native = {
    status: vi.fn(async () => ({ validated })),
    setBeacon: vi.fn(async () => {}),
    clearBeacon: vi.fn(async () => {}),
  }
  const run = () =>
    syncBeacon({ db, native: native as never, genesisHash: DEVNET_GENESIS_HASH, fetchConfig, now: () => NOW })
  return { db, native, fetchConfig, run }
}

describe('the beacon of a phone that can relay', () => {
  it('says online with validated internet, after fetching the configuration it keeps for a day', async () => {
    const { db, native, fetchConfig, run } = await setup(true)
    expect(await run()).toBe(true)
    expect(native.setBeacon).toHaveBeenCalledWith(true, DEVNET_GENESIS_HASH.slice(0, 4), PINNED_GATEWAY_KEYS[0].keyId)
    expect((await loadConfig(db))?.fetchedAt).toBe(NOW)
    await run()
    expect(fetchConfig).toHaveBeenCalledOnce()
  })

  it('clears the beacon without validated internet and fetches nothing', async () => {
    const { native, fetchConfig, run } = await setup(false)
    expect(await run()).toBe(false)
    expect(native.clearBeacon).toHaveBeenCalledOnce()
    expect(native.setBeacon).not.toHaveBeenCalled()
    expect(fetchConfig).not.toHaveBeenCalled()
  })

  it('clears the beacon when the gateway cannot be reached and no configuration is kept', async () => {
    const { native, run } = await setup(
      true,
      vi.fn(async () => Promise.reject(new Error('offline'))),
    )
    expect(await run()).toBe(false)
    expect(native.clearBeacon).toHaveBeenCalledOnce()
  })
})
