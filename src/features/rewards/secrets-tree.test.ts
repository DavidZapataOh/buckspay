import { readFileSync } from 'node:fs'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { emptyRoot, leafOf, merklePath, TREE_DEPTH } from './secrets-tree'

const v = JSON.parse(readFileSync(new URL('../../../prover/testdata/claim-vectors.json', import.meta.url), 'utf8'))
const leaves: Uint8Array[] = v.leaves.map((hex: string) => hexToBytes(hex))

describe('reward tree', () => {
  it('has the circuit root and the circuit siblings for every vector path, byte for byte', () => {
    for (const p of v.paths) {
      const path = merklePath(leaves, p.index)
      expect(bytesToHex(path.root)).toBe(v.root)
      expect(path.siblings.map(bytesToHex)).toEqual(p.siblings)
    }
  })

  it('gives every leaf a path to the same root', () => {
    const roots = new Set(leaves.map((_, i) => bytesToHex(merklePath(leaves, i).root)))
    expect([...roots]).toEqual([v.root])
  })

  it('derives each leaf from its inner and exponent', () => {
    for (const d of v.derivations) expect(bytesToHex(leafOf(hexToBytes(d.inner), d.exp))).toBe(d.leaf)
  })

  it('starts from the empty root and refuses a leaf that is not there', () => {
    expect(bytesToHex(emptyRoot())).toBe(v.zeros[TREE_DEPTH])
    expect(() => merklePath(leaves, leaves.length)).toThrow('not in this tree')
    expect(() => merklePath(leaves, -1)).toThrow('not in this tree')
    expect(() => merklePath([new Uint8Array(32).fill(0xff)], 0)).toThrow('not below the field order')
  })
})
