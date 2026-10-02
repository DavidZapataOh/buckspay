import { address, getBase58Decoder, type Signature } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import type { IdentityState } from './device-identity'
import { confirmingNotice, costNotice, homeStatus, keyProtection, shortfallNotice, stepCopy } from './identity-copy'

const ALICE = address('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS')
const device = { address: ALICE, wallet: ALICE, key: new Uint8Array(33), registeredSlot: 7n }

describe('identity copy', () => {
  it('says what registering costs, rounded up, and what the wallet lacks, rounded down', () => {
    expect(costNotice({ balance: 0n, cost: 1_527_280n })).toBe(
      'Costs about 0.0016 SOL from your wallet. Not refundable.',
    )
    expect(shortfallNotice({ balance: 1_099_999n, cost: 1_527_280n })).toBe(
      'Your wallet has 0.001 SOL. Add SOL to it before you register.',
    )
    expect(shortfallNotice({ balance: 1_527_280n, cost: 1_527_280n })).toBeUndefined()
  })

  it('tells the public, permanent link before registering, and that a sent registration cannot be cancelled', () => {
    expect(stepCopy.register.body).toBe(
      'This links this phone to your wallet publicly and permanently. Anyone can see the link on Solana, and it can’t be undone.',
    )
    expect([stepCopy.connect.progress, stepCopy['create-key'].progress, stepCopy.register.progress]).toEqual([
      'Step 1 of 2',
      'Step 1 of 2',
      'Step 2 of 2',
    ])
    const sent = getBase58Decoder().decode(new Uint8Array(64).fill(1)) as Signature
    expect(confirmingNotice(sent)).toBe(
      'Sent to Solana. Waiting for confirmation, usually under a minute. You can leave this screen; this can’t be cancelled.',
    )
    expect(confirmingNotice()).toBe(
      'Your wallet may have sent the registration. Waiting until Solana confirms it or it expires, usually under a minute. You can leave this screen.',
    )
  })

  it('names how the key is protected in plain words', () => {
    expect([keyProtection.strongbox, keyProtection.tee, keyProtection.software]).toEqual([
      'Secure chip (StrongBox)',
      'Secure hardware (TEE)',
      'Software only',
    ])
  })

  it('gives Home one status for each state, true at confirmed', () => {
    const status = (state: IdentityState) => homeStatus(state)
    expect(status({ step: 'loading' })).toEqual({ testID: 'home-loading', title: 'Checking this phone…' })
    expect(status({ step: 'ready', wallet: ALICE, device })).toEqual({
      testID: 'device-ready',
      title: 'This phone is registered to your wallet',
    })
    expect(status({ step: 'connect', device })).toMatchObject({
      testID: 'home-reconnect',
      title: 'Reconnect your wallet to pay',
      action: 'Reconnect wallet',
    })
    expect(status({ step: 'other-wallet', wallet: ALICE, device })).toMatchObject({
      testID: 'home-other-wallet',
      action: 'Connect another wallet',
    })
    expect(status({ step: 'confirming' })).toMatchObject({ testID: 'home-confirming', action: 'See progress' })
    expect(status({ step: 'unreachable', error: 'offline' })).toMatchObject({
      testID: 'home-unreachable',
      title: 'Can’t reach Solana',
      retry: 'Try again',
    })
    expect(status({ step: 'loading', error: 'Keystore failed' })).toMatchObject({ retry: 'Try again' })
    for (const step of ['connect', 'create-key', 'register'] as const) {
      expect(status({ step })).toMatchObject({ testID: 'home-setup', action: 'Set up payments' })
    }
  })
})
