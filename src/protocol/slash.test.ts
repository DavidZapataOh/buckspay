import { describe, expect, it } from 'vitest'
import vectors from '../../anchor/crates/protocol/tests/vectors/v1.json'
import { U64_MAX } from './codec'
import { covers, exposure, minBond, paymentLimit, penalty } from './slash'

describe('what a claim burns and what a bond backs', () => {
  it('burns what Rust burns, for every pair of the vectors', () => {
    for (const { loss, free, burn } of vectors.slash.penalties) {
      expect(penalty(BigInt(loss), BigInt(free)), `${loss} against ${free}`).toBe(BigInt(burn))
    }
  })

  it('limits a payment like Rust', () => {
    for (const row of vectors.slash.limits) {
      const bond = BigInt(row.bond)
      expect(exposure(bond)).toBe(BigInt(row.exposure))
      expect(paymentLimit(bond)).toBe(BigInt(row.payment_limit))
      expect(covers(bond, paymentLimit(bond))).toBe(row.covers_the_limit)
      expect(covers(bond, paymentLimit(bond) + 1n)).toBe(row.covers_one_more)
    }
  })

  it('asks for the smallest covering bond like Rust, and for none past what a u64 holds', () => {
    for (const { amount, bond } of vectors.slash.min_bonds) {
      expect(minBond(BigInt(amount)), amount).toBe(bond === null ? undefined : BigInt(bond))
    }
    expect(minBond(100n)).toBe(400n)
    expect(minBond(U64_MAX)).toBeUndefined()
  })

  it('never burns more than the free bond or more than twice the loss', () => {
    for (let loss = 0n; loss < 40n; loss++) {
      for (let free = 0n; free < 90n; free++) {
        const burn = penalty(loss, free)
        expect(burn <= free && burn <= 2n * loss).toBe(true)
        expect(burn === 2n * loss || burn === free).toBe(true)
      }
    }
  })

  it('refuses values that are not a u64', () => {
    expect(() => penalty(-1n, 0n)).toThrow(expect.objectContaining({ code: 'Length' }))
    expect(() => covers(U64_MAX + 1n, 0n)).toThrow(expect.objectContaining({ code: 'Length' }))
    expect(() => minBond(-1n)).toThrow(expect.objectContaining({ code: 'Length' }))
  })
})
