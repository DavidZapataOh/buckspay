import { describe, expect, it } from 'vitest'
import { getBuildNetwork } from './build-network'

describe('build network', () => {
  it('is devnet unless the build names another one', () => {
    const devnet = { cluster: 'devnet', labelKey: 'devnet', network: { id: 'solana:devnet' } }
    expect(getBuildNetwork()).toMatchObject(devnet)
    expect(getBuildNetwork('devnet')).toMatchObject(devnet)
  })

  it('maps test builds on a local validator to the devnet cluster explicitly', () => {
    expect(getBuildNetwork('localnet')).toMatchObject({
      cluster: 'devnet',
      labelKey: 'localnet',
      network: { id: 'solana:localnet', url: 'http://localhost:8899' },
    })
  })

  it('refuses any other network, mainnet included until its program is deployed', () => {
    for (const name of ['mainnet', 'testnet', '']) expect(() => getBuildNetwork(name)).toThrow('Unknown network')
  })
})
