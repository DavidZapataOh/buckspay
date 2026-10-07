import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToNumberLE } from '@noble/curves/utils.js'

/** The discriminator of an Anchor account: the first 8 bytes of the hash of "account:" and its name. */
export const ZK_MINT_DISCRIMINATOR = sha256(new TextEncoder().encode('account:ZkMint')).subarray(0, 8)

const FEE_OFFSET = 8 + 8 + 8

/** The fee the program withholds for each record a private settlement creates, read from a `ZkMint` account. */
export function recordFee(account: Uint8Array): bigint {
  if (account.length < FEE_OFFSET + 8 || ZK_MINT_DISCRIMINATOR.some((byte, i) => account[i] !== byte)) {
    throw new Error('Not a ZkMint account.')
  }
  return bytesToNumberLE(account.subarray(FEE_OFFSET, FEE_OFFSET + 8))
}

/**
 * What the payee of a private settlement receives of `payAmount` when the chain has `hops` holders before the
 * settling spend: the fee is taken for one record per spend, the settling one included.
 */
export const netOfFees = (payAmount: bigint, fee: bigint, hops: number) => payAmount - fee * BigInt(hops + 1)

/** A receiver takes a note only if what a private settlement would pay it still covers what it was promised. */
export const coversExpected = (payAmount: bigint, expected: bigint, fee: bigint, hops: number) =>
  netOfFees(payAmount, fee, hops) >= expected
