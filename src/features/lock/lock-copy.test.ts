import { address } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { resolveProfile } from '../../protocol'
import {
  feeNotice,
  lockSummary,
  minimumNotice,
  networkCostNotice,
  onboardingCopy,
  rotationNotice,
  withdrawalDateNotice,
  withdrawalStatus,
} from './lock-copy'
import type { LockRecord } from './locks'

const { windows } = resolveProfile({})
const ALICE = address('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS')
const lock: LockRecord = {
  address: ALICE,
  mint: ALICE,
  payer: ALICE,
  lockSeq: 0,
  bond: 2_000_000n,
  backing: 3_000_000n,
  backingLeft: 2_500_000n,
  bondFree: 1_500_000n,
  bondSlashed: 0n,
  lockUntil: 1_900_000_000,
  withdrawn: false,
}

describe('lock copy', () => {
  it('says exactly what a wallet that changed the transaction costs the user', () => {
    expect(onboardingCopy.walletChangedTransaction).toBe(
      'Your wallet changed the transaction, so Buckspay could not cover its network cost. Nothing was sent and nothing was charged. Open Buckspay in Phantom or Solflare, or add about 0.005 SOL to activate with your own wallet.',
    )
  })

  it('shows the minimum, the fee or that there is none, and who pays the network', () => {
    expect(minimumNotice(5_000_000n, 6)).toBe('The minimum to add is 5 USDC.')
    expect(feeNotice(0n, 6)).toBe('There is no fee.')
    expect(feeNotice(150_000n, 6)).toBe('Buckspay charges a fee of 0.15 USDC, on top of your funds.')
    expect(networkCostNotice(true, 0n)).toBe('Buckspay pays the network costs. Your wallet pays nothing else.')
    expect(networkCostNotice(false, 4_600_000n)).toBe(
      'Your wallet pays the network costs, about 0.0046 SOL. Not refundable.',
    )
  })

  it('names the date funds can be taken back, a claim window after the lock', () => {
    expect(withdrawalDateNotice(1_900_000_000, windows)).toBe('You can take your funds back from 2030-03-24 (UTC).')
  })

  it('summarizes what a lock holds, with the slashed pool only when there is one', () => {
    expect(lockSummary(lock, 6)).toBe('2.5 USDC backing left, 1.5 USDC bond free')
    expect(lockSummary({ ...lock, bondSlashed: 500_000n }, 6)).toBe(
      '2.5 USDC backing left, 1.5 USDC bond free, 0.5 USDC slashed',
    )
  })

  it('offers withdrawal only once the window has passed', () => {
    const opens = lock.lockUntil + windows.claimWindow
    expect(withdrawalStatus(lock, windows, opens - 1).canWithdraw).toBe(false)
    expect(withdrawalStatus(lock, windows, opens)).toEqual({
      text: 'You can take your funds back now.',
      canWithdraw: true,
    })
    expect(withdrawalStatus({ ...lock, withdrawn: true }, windows, opens)).toEqual({
      text: 'Withdrawn.',
      canWithdraw: false,
    })
  })

  it('names the wallet a pending rotation moves this phone to, and when it takes effect', () => {
    expect(rotationNotice(ALICE, 1_900_000_000)).toBe(
      `Someone asked to move this phone to wallet ${ALICE}. It takes effect on 2030-03-17 (UTC). If this wasn’t you, cancel it now.`,
    )
  })
})
