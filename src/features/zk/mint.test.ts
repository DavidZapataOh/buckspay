import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'
import { coversExpected, netOfFees, recordFee, ZK_MINT_DISCRIMINATOR } from './mint'

const account = (fee: bigint) => {
  const out = new Uint8Array(8 + 8 + 8 + 8 + 32 + 24 + 1)
  out.set(ZK_MINT_DISCRIMINATOR)
  new DataView(out.buffer).setBigUint64(24, fee, true)
  return out
}

describe('ZkMint', () => {
  it('names the account the way Anchor does', () => {
    expect(ZK_MINT_DISCRIMINATOR).toEqual(sha256(new TextEncoder().encode('account:ZkMint')).subarray(0, 8))
  })
  it('reads the record fee after the two caps', () => {
    expect(recordFee(account(12_345n))).toBe(12_345n)
  })
  it('refuses another account or a short one', () => {
    expect(() => recordFee(new Uint8Array(100))).toThrow()
    expect(() => recordFee(account(1n).subarray(0, 20))).toThrow()
  })
})

describe('what a private settlement pays', () => {
  it('takes one fee per spend, the settling one included', () => {
    expect(netOfFees(1_000_000n, 5_000n, 3)).toBe(980_000n)
  })
  it('accepts a note whose net still covers what was promised, to the base unit', () => {
    expect(coversExpected(1_000_000n, 980_000n, 5_000n, 3)).toBe(true)
    expect(coversExpected(1_000_000n, 980_001n, 5_000n, 3)).toBe(false)
  })
  it('refuses a note padded with hops until the fees eat the payment', () => {
    expect(coversExpected(1_000_000n, 920_000n, 5_000n, 16)).toBe(false)
  })
})
