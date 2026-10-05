import { address, getBase58Decoder, type Signature } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import type { Activation } from './activation'
import type { IdentityState } from './device-identity'
import {
  confirmingNotice,
  homeStatus,
  keyProtection,
  shortfallNotice,
  sponsorshipNotice,
  stepCopy,
} from './identity-copy'

const ALICE = address('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS')
const device = { address: ALICE, wallet: ALICE, key: new Uint8Array(33) }

describe('identity copy', () => {
  it('says what the wallet lacks in SOL to pay the network itself, rounded down, and nothing while Buckspay pays', () => {
    const activation = (balance: bigint, cost: bigint) => ({ sol: { balance, cost } }) as Activation
    expect(shortfallNotice(activation(1_099_999n, 4_600_000n), false)).toBe(
      'Your wallet has 0.001 SOL. Add SOL to it before you activate.',
    )
    expect(shortfallNotice(activation(4_600_000n, 4_600_000n), false)).toBeUndefined()
    expect(shortfallNotice(activation(0n, 4_600_000n), true)).toBeUndefined()
  })

  it('says why the wallet pays when Buckspay does not', () => {
    expect(sponsorshipNotice('unavailable')).toBe(
      'Buckspay can’t pay for activations right now, so your wallet pays the network costs.',
    )
    expect(sponsorshipNotice('free')).toBeUndefined()
    expect(sponsorshipNotice()).toBeUndefined()
  })

  it('tells the public, permanent link before activating, and that a sent activation cannot be cancelled', () => {
    expect(stepCopy.activate.title).toBe('Add funds')
    expect(stepCopy.activate.body).toContain('publicly and permanently')
    expect([stepCopy.connect.progress, stepCopy['create-key'].progress, stepCopy.activate.progress]).toEqual([
      'Step 1 of 2',
      'Step 1 of 2',
      'Step 2 of 2',
    ])
    const sent = getBase58Decoder().decode(new Uint8Array(64).fill(1)) as Signature
    expect(confirmingNotice(sent)).toBe(
      'Sent to Solana. Waiting for confirmation, usually under a minute. You can leave this screen; this can’t be cancelled.',
    )
    expect(confirmingNotice()).toBe(
      'Your wallet may have sent the activation. Waiting until Solana confirms it or it expires, usually under a minute. You can leave this screen.',
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
    for (const step of ['connect', 'create-key', 'activate'] as const) {
      expect(status({ step })).toMatchObject({ testID: 'home-setup', action: 'Set up payments' })
    }
  })
})
