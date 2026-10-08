import { describe, expect, it } from 'vitest'
import { seeded } from '../../transport/testing/random'
import { runCyclesBench, summariseWeeks, timerResolutionMs, weekOfDebts } from './cycles.bench'
import { cancelCycles, type Debt, MAX_TOTAL, netPositions, remaining, simplify, type Transfer } from './cycles'

const d = (id: string, debtor: number, creditor: number, amount: bigint): Debt => ({ id, debtor, creditor, amount })
const sum = (values: readonly bigint[]) => values.reduce((a, b) => a + b, 0n)
const show = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))

describe('cancelCycles examples', () => {
  it('cancels the smallest tab of a triangle on every tab', () => {
    const debts = [d('ab', 0, 1, 10n), d('bc', 1, 2, 7n), d('ca', 2, 0, 5n)]
    expect(cancelCycles(3, debts)).toEqual({ cancel: [5n, 5n, 5n], total: 15n })
  })

  it('cancels two disjoint cycles independently', () => {
    const debts = [
      d('a', 0, 1, 4n),
      d('b', 1, 2, 9n),
      d('c', 2, 0, 6n),
      d('x', 3, 4, 8n),
      d('y', 4, 5, 3n),
      d('z', 5, 3, 3n),
    ]
    expect(cancelCycles(6, debts)).toEqual({ cancel: [4n, 4n, 4n, 3n, 3n, 3n], total: 21n })
  })

  it('cancels nothing on a chain', () => {
    const debts = [d('a', 0, 1, 5n), d('b', 1, 2, 5n)]
    expect(cancelCycles(3, debts)).toEqual({ cancel: [0n, 0n], total: 0n })
  })

  it('cancels the smaller of two opposite tabs on both', () => {
    expect(cancelCycles(2, [d('a', 0, 1, 8n), d('b', 1, 0, 3n)])).toEqual({ cancel: [3n, 3n], total: 6n })
  })

  it('prefers a long cycle to a short one that blocks it', () => {
    const debts = [d('a', 0, 1, 10n), d('b', 1, 2, 10n), d('c', 2, 0, 10n), d('d', 1, 0, 10n)]
    expect(cancelCycles(3, debts)).toEqual({ cancel: [10n, 10n, 10n, 0n], total: 30n })
  })

  it('splits a shared tab between two overlapping cycles', () => {
    const debts = [d('a', 0, 1, 10n), d('b', 1, 2, 4n), d('c', 2, 0, 4n), d('d', 1, 0, 5n)]
    expect(cancelCycles(3, debts)).toEqual({ cancel: [9n, 4n, 4n, 5n], total: 22n })
  })

  it('cancels the lowest id first when parallel tabs tie', () => {
    const debts = [d('y', 0, 1, 5n), d('x', 0, 1, 5n), d('z', 1, 0, 5n)]
    expect(cancelCycles(2, debts)).toEqual({ cancel: [0n, 5n, 5n], total: 10n })
  })

  it('returns an empty cancellation for no tabs and for tabs of zero', () => {
    expect(cancelCycles(1, [])).toEqual({ cancel: [], total: 0n })
    expect(cancelCycles(2, [d('a', 0, 1, 0n), d('b', 1, 0, 0n)])).toEqual({ cancel: [0n, 0n], total: 0n })
  })

  it('does not modify its input', () => {
    const debts = Object.freeze([Object.freeze(d('a', 0, 1, 5n)), Object.freeze(d('b', 1, 0, 5n))])
    expect(cancelCycles(2, debts).total).toBe(10n)
  })

  it('total_overflow_cancels_less: stays below 2^64 on a long cycle of large tabs', () => {
    const big = 2n ** 63n
    const debts = Array.from({ length: 8 }, (_, i) => d(`t${i}`, i, (i + 1) % 8, big))
    const result = cancelCycles(8, debts)
    expect(result.cancel).toEqual(new Array(8).fill(2n ** 61n - 1n))
    expect(result.total).toBe(2n ** 64n - 8n)
    expect(netPositions(8, remaining(debts, result.cancel))).toEqual(netPositions(8, debts))
  })

  it('honours a small maxTotal', () => {
    const debts = [d('a', 0, 1, 100n), d('b', 1, 2, 100n), d('c', 2, 0, 100n)]
    expect(cancelCycles(3, debts, 10n)).toEqual({ cancel: [3n, 3n, 3n], total: 9n })
  })

  it('does not let a maxTotal above the optimum change the result', () => {
    const debts = [d('a', 0, 1, 10n), d('b', 1, 2, 7n), d('c', 2, 0, 5n)]
    expect(cancelCycles(3, debts, 15n)).toEqual(cancelCycles(3, debts))
  })

  it('gives the same answer for a shuffled input', () => {
    const debts = [d('a', 0, 1, 10n), d('b', 1, 2, 4n), d('c', 2, 0, 4n), d('d', 1, 0, 5n)]
    const result = cancelCycles(3, [debts[3], debts[1], debts[0], debts[2]])
    expect(result).toEqual({ cancel: [5n, 4n, 9n, 4n], total: 22n })
  })
})

describe('input rules', () => {
  const ok = [d('a', 0, 1, 1n)]
  it.each([
    ['0 participants', () => cancelCycles(0, [])],
    ['65 participants', () => cancelCycles(65, [])],
    ['a fractional participant count', () => cancelCycles(2.5, [])],
    ['a negative debtor', () => cancelCycles(2, [d('a', -1, 1, 1n)])],
    ['a debtor out of range', () => cancelCycles(2, [d('a', 2, 1, 1n)])],
    ['a creditor out of range', () => cancelCycles(2, [d('a', 0, 2, 1n)])],
    ['a debtor that is its own creditor', () => cancelCycles(2, [d('a', 1, 1, 1n)])],
    ['a negative amount', () => cancelCycles(2, [d('a', 0, 1, -1n)])],
    ['an amount of 2^64', () => cancelCycles(2, [d('a', 0, 1, 2n ** 64n)])],
    ['a repeated id', () => cancelCycles(2, [d('a', 0, 1, 1n), d('a', 1, 0, 1n)])],
    ['maxTotal 0', () => cancelCycles(2, ok, 0n)],
    ['maxTotal above 2^64 - 1', () => cancelCycles(2, ok, MAX_TOTAL + 1n)],
    ['netPositions with a bad index', () => netPositions(2, [d('a', 0, 5, 1n)])],
    ['simplify with a repeated id', () => simplify(2, [d('a', 0, 1, 1n), d('a', 1, 0, 1n)])],
    ['remaining with a short cancellation', () => remaining(ok, [])],
    ['remaining with a cancellation above the amount', () => remaining(ok, [2n])],
    ['remaining with a negative cancellation', () => remaining(ok, [-1n])],
  ])('refuses %s with a RangeError', (_, call) => {
    expect(call).toThrow(RangeError)
  })

  it('accepts an amount of 2^64 - 1 and a maxTotal of 2^64 - 1', () => {
    expect(cancelCycles(2, [d('a', 0, 1, MAX_TOTAL), d('b', 1, 0, MAX_TOTAL)], MAX_TOTAL).total).toBe(MAX_TOTAL - 1n)
  })
})

describe('netPositions and remaining', () => {
  it('reports credit minus debt for each person', () => {
    expect(netPositions(3, [d('a', 0, 1, 10n), d('b', 1, 2, 7n), d('c', 0, 2, 1n)])).toEqual([-11n, 3n, 8n])
  })

  it('drops the tabs that cancel to zero, keeps the order and the ids', () => {
    const debts = [d('a', 0, 1, 10n), d('b', 1, 2, 7n), d('c', 2, 0, 5n)]
    expect(remaining(debts, [5n, 7n, 5n])).toEqual([d('a', 0, 1, 5n)])
  })
})

type Scale = 'tiny' | 'usdc' | 'wide' | 'huge'
const SCALES: Scale[] = ['tiny', 'usdc', 'wide', 'huge']
type Case = { n: number; debts: Debt[] }
type Rng = () => number

const below = (r: Rng, bound: number) => Math.floor(r() * bound)

function wideBits(r: Rng, bits: number): bigint {
  let value = 0n
  for (let done = 0; done < bits; done += 16) value = (value << 16n) | BigInt(below(r, 65536))
  return value & ((1n << BigInt(bits)) - 1n)
}

function amount(r: Rng, scale: Scale): bigint {
  if (scale === 'tiny') return BigInt(below(r, 6))
  if (scale === 'usdc') return BigInt(1 + below(r, 5_000_000_000))
  if (scale === 'wide') return wideBits(r, 63)
  return (1n << 62n) + wideBits(r, 63)
}

function shuffled<T>(r: Rng, items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = below(r, i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function randomCase(r: Rng, scale: Scale): Case {
  const n = 2 + below(r, 7)
  const debts: Debt[] = []
  const density = 0.25 + r() * 0.65
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      if (a !== b && r() < density) debts.push(d(`p${a}-${b}`, a, b, amount(r, scale)))
    }
  }
  for (let k = below(r, 4); k > 0; k--) {
    const a = below(r, n)
    debts.push(d(`x${k}`, a, (a + 1 + below(r, n - 1)) % n, amount(r, scale)))
  }
  return { n, debts }
}

function ringCase(r: Rng, scale: Scale): Case {
  const n = 3 + below(r, 6)
  const ring = shuffled(
    r,
    Array.from({ length: n }, (_, i) => i),
  ).slice(0, 3 + below(r, n - 2))
  const debts = ring.map((from, i) => d(`r${i}`, from, ring[(i + 1) % ring.length], amount(r, scale)))
  for (let k = below(r, n + 1); k > 0; k--) {
    const a = below(r, n)
    debts.push(d(`c${k}`, a, (a + 1 + below(r, n - 1)) % n, amount(r, scale)))
  }
  return { n, debts }
}

const caseFor = (r: Rng, i: number): Case => (i % 2 === 0 ? randomCase : ringCase)(r, SCALES[(i >> 1) % SCALES.length])

function expectCirculation(
  n: number,
  debts: readonly Debt[],
  result: { cancel: bigint[]; total: bigint },
  label: string,
) {
  expect(result.cancel, label).toHaveLength(debts.length)
  const flowIn = new Array<bigint>(n).fill(0n)
  const flowOut = new Array<bigint>(n).fill(0n)
  debts.forEach((debt, i) => {
    const cancelled = result.cancel[i]
    expect(
      cancelled >= 0n && cancelled <= debt.amount,
      `${label}: ${debt.id} cancelled ${cancelled} of ${debt.amount}`,
    ).toBe(true)
    flowOut[debt.debtor] += cancelled
    flowIn[debt.creditor] += cancelled
  })
  expect(flowIn, label).toEqual(flowOut)
  expect(result.total, label).toBe(sum(result.cancel))
}

function hasNegativeResidualCycle(n: number, debts: readonly Debt[], cancel: readonly bigint[]): boolean {
  const arcs: [number, number, number][] = []
  debts.forEach((debt, i) => {
    if (debt.amount - cancel[i] > 0n) arcs.push([debt.debtor, debt.creditor, -1])
    if (cancel[i] > 0n) arcs.push([debt.creditor, debt.debtor, 1])
  })
  const dist = new Array<number>(n).fill(0)
  for (let pass = 0; pass <= n; pass++) {
    let changed = false
    for (const [from, to, cost] of arcs) {
      if (dist[from] + cost < dist[to]) {
        dist[to] = dist[from] + cost
        changed = true
      }
    }
    if (!changed) return false
  }
  return true
}

function bruteForceMax(n: number, debts: readonly Debt[], cap: bigint): bigint {
  const balance = new Array<bigint>(n).fill(0n)
  let best = 0n
  const walk = (i: number, total: bigint) => {
    if (i === debts.length) {
      if (total > best && balance.every((b) => b === 0n)) best = total
      return
    }
    const { debtor, creditor, amount: limit } = debts[i]
    for (let c = 0n; c <= limit && total + c <= cap; c++) {
      balance[debtor] -= c
      balance[creditor] += c
      walk(i + 1, total + c)
      balance[debtor] += c
      balance[creditor] -= c
    }
  }
  walk(0, 0n)
  return best
}

function smallCase(r: Rng): Case {
  const n = 2 + below(r, 3)
  const debts = Array.from({ length: 1 + below(r, 6) }, (_, k) => {
    const a = below(r, n)
    return d(`s${k}`, a, (a + 1 + below(r, n - 1)) % n, BigInt(below(r, 4)))
  })
  return { n, debts }
}

const CASES = 10_000

describe('cancelCycles properties', () => {
  it('keeps every net position, stays within each tab and adds no counterparty', () => {
    const r = seeded(20260801)
    for (let i = 0; i < CASES; i++) {
      const { n, debts } = caseFor(r, i)
      const label = `case ${i}: ${show({ n, debts })}`
      const result = cancelCycles(n, debts)
      expectCirculation(n, debts, result, label)
      const rest = remaining(debts, result.cancel)
      expect(netPositions(n, rest), label).toEqual(netPositions(n, debts))
      const ids = new Set(debts.map((debt) => debt.id))
      const pairs = new Set(debts.map((debt) => `${debt.debtor}>${debt.creditor}`))
      for (const debt of rest) {
        expect(ids.has(debt.id) && pairs.has(`${debt.debtor}>${debt.creditor}`), label).toBe(true)
      }
      expect(result.total <= MAX_TOTAL, label).toBe(true)
    }
  })

  it('leaves no negative cycle in the residual network unless the cap stopped it', () => {
    const r = seeded(20260802)
    let certified = 0
    for (let i = 0; i < CASES; i++) {
      const { n, debts } = caseFor(r, i)
      const label = `case ${i}: ${show({ n, debts })}`
      const { cancel, total } = cancelCycles(n, debts)
      if (total <= MAX_TOTAL - BigInt(n)) {
        expect(hasNegativeResidualCycle(n, debts, cancel), label).toBe(false)
        certified++
      }
    }
    expect(certified).toBeGreaterThan(CASES * 0.6)
  })

  it('is the same under any permutation of the input', () => {
    const r = seeded(20260803)
    for (let i = 0; i < CASES; i++) {
      const { n, debts } = caseFor(r, i)
      const label = `case ${i}: ${show({ n, debts })}`
      const base = cancelCycles(n, debts)
      const byId = new Map(debts.map((debt, k) => [debt.id, base.cancel[k]]))
      const permuted = shuffled(r, debts)
      const again = cancelCycles(n, permuted)
      expect(again.total, label).toBe(base.total)
      expect(again.cancel, label).toEqual(permuted.map((debt) => byId.get(debt.id)))
    }
  })

  it('cancels nothing more on what it left', () => {
    const r = seeded(20260804)
    for (let i = 0; i < CASES; i++) {
      const { n, debts } = caseFor(r, i)
      const label = `case ${i}: ${show({ n, debts })}`
      const first = cancelCycles(n, debts)
      if (first.total > MAX_TOTAL - BigInt(n)) continue
      expect(cancelCycles(n, remaining(debts, first.cancel)).total, label).toBe(0n)
    }
  })

  it('matches a brute-force search on small groups', () => {
    const r = seeded(20260805)
    for (let i = 0; i < 600; i++) {
      const { n, debts } = smallCase(r)
      const label = `case ${i}: ${show({ n, debts })}`
      const result = cancelCycles(n, debts)
      expectCirculation(n, debts, result, label)
      expect(result.total, label).toBe(bruteForceMax(n, debts, MAX_TOTAL))
    }
  })

  it('respects a small maxTotal and is optimal whenever the optimum fits under it', () => {
    const r = seeded(20260806)
    for (let i = 0; i < 600; i++) {
      const { n, debts } = smallCase(r)
      const cap = BigInt(1 + below(r, 14))
      const label = `case ${i} cap ${cap}: ${show({ n, debts })}`
      const result = cancelCycles(n, debts, cap)
      expectCirculation(n, debts, result, label)
      const optimum = bruteForceMax(n, debts, MAX_TOTAL)
      expect(result.total <= cap, label).toBe(true)
      expect(result.total, label).toBe(optimum <= cap ? optimum : result.total)
      expect(result.total <= bruteForceMax(n, debts, cap), label).toBe(true)
    }
  })

  it('never reaches 2^64 on tabs near 2^64 and still keeps every net position', () => {
    const r = seeded(20260807)
    for (let i = 0; i < 2000; i++) {
      const n = 3 + below(r, 6)
      const ring = Array.from({ length: n }, (_, k) => d(`h${k}`, k, (k + 1) % n, MAX_TOTAL - BigInt(below(r, 1000))))
      const chords = Array.from({ length: below(r, n) }, (_, k) => {
        const a = below(r, n)
        return d(`k${k}`, a, (a + 1 + below(r, n - 1)) % n, MAX_TOTAL - BigInt(below(r, 1000)))
      })
      const debts = [...ring, ...chords]
      const label = `case ${i}: ${show({ n, debts })}`
      const result = cancelCycles(n, debts)
      expectCirculation(n, debts, result, label)
      expect(result.total <= MAX_TOTAL, label).toBe(true)
      expect(result.total > MAX_TOTAL - BigInt(n), label).toBe(true)
    }
  })

  it('handles 64 people', () => {
    const r = seeded(20260808)
    const n = 64
    const debts: Debt[] = []
    for (let k = 0; k < 300; k++) {
      const a = below(r, n)
      debts.push(d(`m${k}`, a, (a + 1 + below(r, n - 1)) % n, amount(r, 'usdc')))
    }
    const result = cancelCycles(n, debts)
    expectCirculation(n, debts, result, 'n=64')
    expect(hasNegativeResidualCycle(n, debts, result.cancel)).toBe(false)
  })
})

function applyTransfers(rest: readonly Debt[], transfers: readonly Transfer[]): Debt[] {
  const left = new Map<string, bigint>()
  const key = (a: number, b: number) => `${a}>${b}`
  for (const debt of rest)
    left.set(key(debt.debtor, debt.creditor), (left.get(key(debt.debtor, debt.creditor)) ?? 0n) + debt.amount)
  for (const transfer of transfers) {
    const path = [transfer.payer, ...transfer.via, transfer.payee]
    for (let i = 0; i + 1 < path.length; i++) {
      const tab = key(path[i], path[i + 1])
      const have = left.get(tab) ?? 0n
      if (have < transfer.amount) throw new Error(`transfer ${show(transfer)} exceeds the tab ${tab}`)
      left.set(tab, have - transfer.amount)
    }
  }
  return [...left]
    .filter(([, value]) => value > 0n)
    .map(([tab, value]) => {
      const [a, b] = tab.split('>').map(Number)
      return d(tab, a, b, value)
    })
}

describe('simplify examples', () => {
  it('replaces a chain by one payment along it, then pays the rest of the first tab', () => {
    const rest = [d('ab', 0, 1, 10n), d('bc', 1, 2, 7n)]
    expect(simplify(3, rest)).toEqual([
      { payer: 0, payee: 2, amount: 7n, via: [1] },
      { payer: 0, payee: 1, amount: 3n, via: [] },
    ])
  })

  it('pays a long chain in one transfer', () => {
    const rest = [d('a', 0, 1, 5n), d('b', 1, 2, 5n), d('c', 2, 3, 5n)]
    expect(simplify(4, rest)).toEqual([{ payer: 0, payee: 3, amount: 5n, via: [1, 2] }])
  })

  it('settles a shortcut tab together with the chain that parallels it', () => {
    const rest = [d('ab', 0, 1, 5n), d('bc', 1, 2, 5n), d('ac', 0, 2, 5n)]
    expect(simplify(3, rest)).toEqual([
      { payer: 0, payee: 2, amount: 5n, via: [1] },
      { payer: 0, payee: 2, amount: 5n, via: [] },
    ])
  })

  it('returns nothing when there is nothing to pay', () => {
    expect(simplify(3, [])).toEqual([])
    expect(simplify(3, [d('a', 0, 1, 0n)])).toEqual([])
  })

  it('adds up parallel tabs of a pair', () => {
    expect(simplify(2, [d('x', 0, 1, 2n), d('y', 0, 1, 3n)])).toEqual([{ payer: 0, payee: 1, amount: 5n, via: [] }])
  })

  it('needs one transfer per tab when no path is longer than a tab, more than participants - 1', () => {
    const rest = [d('a', 0, 2, 1n), d('b', 0, 3, 1n), d('c', 1, 2, 1n), d('e', 1, 3, 1n)]
    const transfers = simplify(4, rest)
    expect(transfers).toHaveLength(4)
    expect(applyTransfers(rest, transfers)).toEqual([])
  })

  it('refuses a remainder that has a cycle', () => {
    expect(() => simplify(3, [d('a', 0, 1, 1n), d('b', 1, 2, 1n), d('c', 2, 0, 1n)])).toThrow(/contains a cycle/)
    expect(() => simplify(2, [d('a', 0, 1, 1n), d('b', 1, 0, 1n)])).toThrow(/contains a cycle/)
  })
})

function dagCase(r: Rng): Case {
  const n = 2 + below(r, 9)
  const order = shuffled(
    r,
    Array.from({ length: n }, (_, i) => i),
  )
  const debts: Debt[] = []
  const density = 0.2 + r() * 0.7
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (r() < density) debts.push(d(`g${i}-${j}`, order[i], order[j], BigInt(below(r, 40))))
    }
  }
  return { n, debts }
}

function treeCase(r: Rng): Case {
  const n = 2 + below(r, 9)
  const debts: Debt[] = []
  for (let child = 1; child < n; child++) {
    const parent = below(r, child)
    const flip = r() < 0.5
    debts.push(d(`t${child}`, flip ? parent : child, flip ? child : parent, BigInt(1 + below(r, 40))))
  }
  return { n, debts }
}

describe('simplify properties', () => {
  const check = (n: number, rest: readonly Debt[], label: string): Transfer[] => {
    const transfers = simplify(n, rest)
    const pairs = new Set(rest.filter((debt) => debt.amount > 0n).map((debt) => `${debt.debtor}>${debt.creditor}`))
    const paid = new Array<bigint>(n).fill(0n)
    const got = new Array<bigint>(n).fill(0n)
    for (const t of transfers) {
      expect(t.amount > 0n && t.payer !== t.payee, label).toBe(true)
      paid[t.payer] += t.amount
      got[t.payee] += t.amount
    }
    expect(applyTransfers(rest, transfers), label).toEqual([])
    expect(transfers.length <= pairs.size, label).toBe(true)
    const before = netPositions(n, rest)
    const after = netPositions(n, applyTransfersAsDebts(rest, transfers))
    for (let p = 0; p < n; p++) expect(after[p], label).toBe(before[p] + paid[p] - got[p])
    return transfers
  }

  const applyTransfersAsDebts = (rest: readonly Debt[], transfers: readonly Transfer[]) => {
    const merged = new Map<string, bigint>()
    for (const debt of rest)
      merged.set(`${debt.debtor}>${debt.creditor}`, (merged.get(`${debt.debtor}>${debt.creditor}`) ?? 0n) + debt.amount)
    const partial = new Map(merged)
    for (const t of transfers) {
      const path = [t.payer, ...t.via, t.payee]
      for (let i = 0; i + 1 < path.length; i++)
        partial.set(`${path[i]}>${path[i + 1]}`, (partial.get(`${path[i]}>${path[i + 1]}`) as bigint) - t.amount)
    }
    return [...partial].map(([tab, value]) => {
      const [a, b] = tab.split('>').map(Number)
      return d(tab, a, b, value)
    })
  }

  it('zeroes any acyclic remainder along existing tabs and moves each net position by what it pays or gets', () => {
    const r = seeded(20260809)
    for (let i = 0; i < 3000; i++) {
      const { n, debts } = dagCase(r)
      check(n, debts, `case ${i}: ${show({ n, debts })}`)
    }
  })

  it('uses at most participants - 1 transfers when the tabs form a forest', () => {
    const r = seeded(20260810)
    for (let i = 0; i < 3000; i++) {
      const { n, debts } = treeCase(r)
      const label = `case ${i}: ${show({ n, debts })}`
      expect(check(n, debts, label).length <= n - 1, label).toBe(true)
    }
  })

  it('is the same under any permutation of the input', () => {
    const r = seeded(20260811)
    for (let i = 0; i < 2000; i++) {
      const { n, debts } = dagCase(r)
      expect(simplify(n, shuffled(r, debts)), `case ${i}: ${show({ n, debts })}`).toEqual(simplify(n, debts))
    }
  })

  it('simplifies whatever cancelCycles leaves', () => {
    const r = seeded(20260812)
    for (let i = 0; i < CASES / 2; i++) {
      const { n, debts } = caseFor(r, i)
      const label = `case ${i}: ${show({ n, debts })}`
      const result = cancelCycles(n, debts)
      if (result.total > MAX_TOTAL - BigInt(n)) continue
      const rest = remaining(debts, result.cancel)
      check(n, rest, label)
    }
  })
})

describe('benchmark module', () => {
  it('reports ordered percentiles for 3..8 people', () => {
    const rows = runCyclesBench({ graphs: 20 })
    expect(new Set(rows.map((row) => row.n))).toEqual(new Set([3, 4, 5, 6, 7, 8]))
    for (const row of rows) {
      expect(row.p95Ms).toBeGreaterThanOrEqual(row.p50Ms)
      expect(row.maxMs).toBeGreaterThanOrEqual(row.p95Ms)
      expect(row.p50Ms).toBeGreaterThanOrEqual(0)
    }
  })

  it('draws the same groups for the same seed whatever the clock says', () => {
    let tick = 0
    const a = runCyclesBench({ graphs: 10, now: () => tick++ })
    const b = runCyclesBench({ graphs: 10, repeats: 3 })
    expect(a.map((row) => row.checksum)).toEqual(b.map((row) => row.checksum))
  })

  it('draws a week of at most one tab per pair, deterministically', () => {
    const week = weekOfDebts(7)
    expect(week).toEqual(weekOfDebts(7))
    expect(week.length).toBeGreaterThan(0)
    expect(new Set(week.map((debt) => [debt.debtor, debt.creditor].sort().join())).size).toBe(week.length)
    expect(week.every((debt) => debt.amount > 0n && debt.debtor !== debt.creditor)).toBe(true)
  })

  it('summarises weeks with ordered spreads', () => {
    const stats = summariseWeeks(50)
    expect(stats.weeks).toBe(50)
    expect(stats.weeksWithCycle).toBeLessThanOrEqual(50)
    for (const spread of [
      stats.valueCancelledPct,
      stats.tabsBefore,
      stats.tabsAfterNetting,
      stats.transfersAfterSimplify,
    ]) {
      expect(spread.p10).toBeLessThanOrEqual(spread.p50)
      expect(spread.p50).toBeLessThanOrEqual(spread.p90)
    }
    expect(stats.valueCancelledPct.p90).toBeLessThanOrEqual(100)
  })

  it('reads the smallest step of a clock', () => {
    let tick = 0
    expect(timerResolutionMs(() => (tick += 0.25))).toBe(0.25)
  })

  it.runIf(process.env.CYCLES_BENCH === '1')('prints the measurements', () => {
    for (const row of runCyclesBench()) console.log(`CYCLESBENCH ${JSON.stringify({ engine: 'node', ...row })}`)
    console.log(
      `CYCLESBENCH ${JSON.stringify({ engine: 'node', resolutionMs: timerResolutionMs(), weeks: summariseWeeks() })}`,
    )
  })
})
