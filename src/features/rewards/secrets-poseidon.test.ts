import { readFileSync } from 'node:fs'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { BN254_R, fromCanonical, poseidon2, toBytes32 } from './secrets-poseidon'

const vectors = (name: string) => JSON.parse(readFileSync(new URL(`../../../prover/${name}`, import.meta.url), 'utf8'))

describe('poseidon', () => {
  it('matches every vector of the sol_poseidon syscall, and refuses what the syscall refuses', () => {
    const cases = vectors('poseidon/testdata/sol_poseidon.json') as { inputs: string[]; out: string; err: boolean }[]
    expect(cases.length).toBeGreaterThan(60)
    for (const { inputs, out, err } of cases) {
      const [a, b] = inputs.map((hex) => BigInt(`0x${hex}`))
      if (err) expect(() => poseidon2(a, b)).toThrow()
      else expect(bytesToHex(toBytes32(poseidon2(a, b)))).toBe(out)
    }
  })

  it('derives the inner, the leaf and the nullifier hash of the circuit vectors byte for byte', () => {
    const { derivations } = vectors('testdata/claim-vectors.json')
    for (const d of derivations) {
      const n = fromCanonical(hexToBytes(d.nullifier), 'nullifier')
      const inner = poseidon2(n, fromCanonical(hexToBytes(d.trapdoor), 'trapdoor'))
      expect(bytesToHex(toBytes32(inner))).toBe(d.inner)
      expect(bytesToHex(toBytes32(poseidon2(inner, BigInt(d.exp))))).toBe(d.leaf)
      expect(bytesToHex(toBytes32(poseidon2(n, fromCanonical(hexToBytes(d.scope), 'scope'))))).toBe(d.nullifier_hash)
    }
  })

  it('refuses a value of the field order or more before it is hashed', () => {
    const r = toBytes32(BN254_R - 1n)
    expect(fromCanonical(r, 'x')).toBe(BN254_R - 1n)
    expect(() => fromCanonical(hexToBytes(BN254_R.toString(16).padStart(64, '0')), 'x')).toThrow(
      'not below the field order',
    )
    expect(() => fromCanonical(new Uint8Array(31), 'x')).toThrow('32 bytes')
    expect(() => toBytes32(BN254_R)).toThrow()
    expect(() => poseidon2(BN254_R, 1n)).toThrow()
    expect(() => poseidon2(1n, -1n)).toThrow()
  })
})
