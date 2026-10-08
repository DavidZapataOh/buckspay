import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import vectors from '../../../prover/netting/testdata/vectors.json'
import { decodeStatement, sessionField } from '../../protocol/netting'
import {
  digest,
  encodeWitness,
  leaf,
  openingProves,
  rootOf,
  saltFor,
  type Slot,
  SLOTS,
  slotIndex,
  tabField,
} from './digest'

type Case = (typeof vectors.cases)[number]
const big = (hex: string) => BigInt(`0x${hex}`)
const slotOf = (s: Case['slots'][number]): Slot | null =>
  s.present
    ? {
        tab: hexToBytes(s.tabId),
        seq: s.seq,
        dir: s.dir as 0 | 1,
        debt: BigInt(s.debt),
        cancel: BigInt(s.cancel),
        salt: big(s.salt),
      }
    : null
const slotsOf = (c: Case) => c.slots.map(slotOf)
const others = (p: number) => [0, 1, 2, 3, 4, 5, 6, 7].filter((q) => q !== p)
const openingOf = (c: Case, p: number) => ({
  session: hexToBytes(c.session),
  p,
  slots: others(p).map((q) => slotsOf(c)[slotIndex(Math.min(p, q), Math.max(p, q))]),
  digests: c.digests.map(big),
})

describe('netting digests', () => {
  it('numbers the 28 pairs lexicographically', () => {
    let s = 0
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) expect(slotIndex(i, j)).toBe(s++)
    expect(s).toBe(SLOTS)
    expect(() => slotIndex(3, 3)).toThrow(RangeError)
  })

  it('digest_matches_go_vectors', () => {
    expect(vectors.cases).toHaveLength(3)
    expect(leaf(null)).toBe(big(vectors.emptyLeaf))
    for (const c of vectors.cases) {
      const field = sessionField(decodeStatement(hexToBytes(c.statement)))
      expect(field).toEqual(hexToBytes(c.sessionField))
      c.slots.forEach((s, i) => {
        expect(leaf(slotOf(s))).toBe(big(s.leaf))
        if (s.present) expect(tabField(hexToBytes(s.tabId))).toBe(big(s.tab))
        expect(s.index).toBe(i)
      })
      const digests = [0, 1, 2, 3, 4, 5, 6, 7].map((p) => digest(field, p, slotsOf(c)))
      expect(digests).toEqual(c.digests.map(big))
      expect(rootOf(digests)).toBe(big(c.root))
    }
  })

  it('saltFor_is_same_for_both_endpoints', () => {
    for (const c of vectors.cases) {
      const session = hexToBytes(c.session)
      for (const s of c.slots.filter((x) => x.present)) {
        expect(saltFor(hexToBytes(s.tabSeed!), session)).toBe(big(s.salt))
        const other = session.slice()
        other[0] ^= 1
        expect(saltFor(hexToBytes(s.tabSeed!), other)).not.toBe(big(s.salt))
      }
    }
  })

  it('encodeWitness_round_trips_in_go', () => {
    for (const c of vectors.cases) {
      const statement = decodeStatement(hexToBytes(c.statement))
      expect(bytesToHex(encodeWitness(statement, slotsOf(c)))).toBe(c.witness)
    }
  })

  it('leaf_opening_verifies_against_root', () => {
    for (const c of vectors.cases) {
      const statement = decodeStatement(hexToBytes(c.statement))
      c.slots.forEach((s, i) => {
        if (!s.present) return
        const [a, b] = ends(i)
        for (const p of [a, b]) expect(openingProves(openingOf(c, p), statement, hexToBytes(s.tabId), s.seq)).toBe(true)
      })
    }
  })

  it('leaf_opening_with_other_seq_fails', () => {
    const c = vectors.cases[1]
    const statement = decodeStatement(hexToBytes(c.statement))
    const s = c.slots.find((x) => x.present)!
    const [p] = ends(s.index)
    const opening = openingOf(c, p)
    const tab = hexToBytes(s.tabId)
    expect(openingProves(opening, statement, tab, s.seq + 1)).toBe(false)
    expect(openingProves(opening, statement, hexToBytes(c.slots.filter((x) => x.present)[1].tabId), s.seq)).toBe(false)
    const forged = { ...opening, digests: opening.digests.map((d, q) => (q === (p + 1) % 8 ? d + 1n : d)) }
    expect(openingProves(forged, statement, tab, s.seq)).toBe(false)
    const lowered = {
      ...opening,
      slots: opening.slots.map((x) => (x && bytesToHex(x.tab) === bytesToHex(tab) ? { ...x, debt: x.debt - 1n } : x)),
    }
    expect(openingProves(lowered, statement, tab, s.seq)).toBe(false)
    const elsewhere = { ...opening, session: hexToBytes(vectors.cases[0].session) }
    expect(openingProves(elsewhere, statement, tab, s.seq)).toBe(false)
  })

  it('refuses slots outside their ranges', () => {
    const c = vectors.cases[0]
    const session = hexToBytes(c.sessionField)
    const good = slotsOf(c)
    const first = good.findIndex((s) => s !== null)
    const bad = (patch: Partial<Slot>) => good.map((s, i) => (i === first ? { ...s!, ...patch } : s))
    expect(() => digest(session, 0, good.slice(1))).toThrow(RangeError)
    expect(() => digest(session, 0, bad({ seq: 2 ** 32 }))).toThrow(RangeError)
    expect(() => digest(session, 0, bad({ debt: 2n ** 64n }))).toThrow(RangeError)
    expect(() => digest(session, 0, bad({ cancel: -1n }))).toThrow(RangeError)
    expect(() => digest(session, 0, bad({ dir: 2 as 0 }))).toThrow(RangeError)
  })
})

function ends(index: number): [number, number] {
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) if (slotIndex(i, j) === index) return [i, j]
  throw new RangeError('slot')
}
