import { hexToBytes } from '@noble/hashes/utils.js'
import { address, getBase64Decoder, type Transaction } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import onboard from '../../../gateway/tests/fixtures/onboard.json'
import operations from '../../../gateway/tests/fixtures/operations.json'
import {
  buildLockTransaction,
  buildOnboardTransaction,
  buildRotationCancelTransaction,
  buildRotationRequestTransaction,
  buildWithdrawalTransaction,
  type SponsorTerms,
} from './messages'

const terms = (fixture: typeof onboard | typeof operations): SponsorTerms => ({
  programAddress: address(fixture.programId),
  feePayer: address(fixture.feePayer),
  blockhash: fixture.blockhash,
  lastValidBlockHeight: 0n,
  computeUnitLimit: fixture.computeUnitLimit,
  computeUnitPrice: BigInt(fixture.computeUnitPrice),
})
const base64 = (transaction: Transaction) => getBase64Decoder().decode(transaction.messageBytes)

const lock = {
  wallet: address(onboard.wallet),
  key: hexToBytes(onboard.device),
  funder: address(onboard.funder),
  mint: address(onboard.mint),
  tokenProgram: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  bond: BigInt(onboard.bond),
  backing: BigInt(onboard.backing),
  lockUntil: onboard.lockUntil,
}

describe('sponsored messages', () => {
  it('builds the onboarding the gateway builds, byte for byte', async () => {
    const binding = {
      key: hexToBytes(onboard.device),
      signature: hexToBytes(onboard.signature),
      envelope: hexToBytes(onboard.envelope),
    }
    expect(base64(await buildOnboardTransaction(terms(onboard), { ...lock, binding, sponsorFee: 0n }))).toBe(
      onboard.message,
    )
  })

  it('builds the onboarding with the fee lever on, byte for byte', async () => {
    const binding = {
      key: hexToBytes(onboard.device),
      signature: hexToBytes(onboard.signature),
      envelope: hexToBytes(onboard.envelope),
    }
    const withFee = { ...lock, binding, sponsorFee: 150_000n, sponsorToken: address(onboard.feeRecipient) }
    expect(base64(await buildOnboardTransaction(terms(onboard), withFee))).toBe(onboard.messageWithFee)
  })

  it('builds the later lock, the withdrawal and the rotation messages the gateway builds, byte for byte', async () => {
    const t = terms(operations)
    const wallet = address(operations.wallet)
    const key = hexToBytes(operations.device)
    expect(base64(await buildLockTransaction(t, { ...lock, lockSeq: operations.lockSeq }))).toBe(operations.lock)
    expect(
      base64(
        await buildWithdrawalTransaction(t, {
          wallet,
          key,
          rentReceiver: address(operations.rentReceiver),
          lockSeq: operations.lockSeq,
          mint: address(operations.mint),
          tokenProgram: lock.tokenProgram,
          destination: address(operations.destination),
        }),
      ),
    ).toBe(operations.withdrawal)
    const rotation = {
      key,
      newWallet: address(operations.newWallet),
      signature: hexToBytes(operations.rotationSignature),
      envelope: hexToBytes(operations.rotationEnvelope),
    }
    expect(base64(await buildRotationRequestTransaction(t, rotation))).toBe(operations.rotationRequest)
    expect(
      base64(await buildRotationCancelTransaction(t, { wallet, key, rentReceiver: address(operations.rentReceiver) })),
    ).toBe(operations.rotationCancel)
  })

  it('follows the program of another profile', async () => {
    const short = { ...terms(onboard), programAddress: address('JA82vFUvNM3vvRbYbiU3xx748qEchaJ3Htr8FKFEMFKT') }
    const binding = { key: lock.key, signature: new Uint8Array(64), envelope: new Uint8Array(96) }
    const shortMessage = base64(await buildOnboardTransaction(short, { ...lock, binding, sponsorFee: 0n }))
    expect(shortMessage).not.toBe(onboard.message)
  })
})
