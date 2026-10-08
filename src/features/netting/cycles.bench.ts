import { type Cancellation, cancelCycles, type Debt, remaining, simplify } from './cycles'

export type BenchRow = {
  n: number
  shape: 'random' | 'full'
  amounts: 'usdc' | 'wide'
  graphs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  checksum: string
}
export type BenchOptions = { graphs?: number; repeats?: number; now?: () => number }
export type Spread = { p10: number; p50: number; p90: number }
export type WeekStats = {
  weeks: number
  weeksWithCycle: number
  valueCancelledPct: Spread
  tabsBefore: Spread
  tabsAfterNetting: Spread
  transfersAfterSimplify: Spread
}

const SEED_MIX = 0x9e3779b1

function generator(seed: number): () => number {
  let state = Math.imul(seed, SEED_MIX) | 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}

const below = (next: () => number, bound: number) => Math.floor(next() * bound)

function wideAmount(next: () => number): bigint {
  let value = 0n
  for (let i = 0; i < 4; i++) value = (value << 16n) | BigInt(below(next, 65536))
  return (value & ((1n << 63n) - 1n)) + 1n
}

function randomGroup(next: () => number, n: number, shape: BenchRow['shape'], amounts: BenchRow['amounts']): Debt[] {
  const debts: Debt[] = []
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      if (shape === 'random' && next() < 0.3) continue
      const [debtor, creditor] = next() < 0.5 ? [a, b] : [b, a]
      const amount = amounts === 'usdc' ? BigInt(1 + below(next, 1_000_000_000)) : wideAmount(next)
      debts.push({ id: `${debtor}>${creditor}`, debtor, creditor, amount })
    }
  }
  return debts
}

const percentile = (sorted: readonly number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]

/** Times `cancelCycles` on seeded groups of 3 to 8 people; a seed gives the same groups on every engine. */
export function runCyclesBench({
  graphs = 1000,
  repeats = 1,
  now = () => performance.now(),
}: BenchOptions = {}): BenchRow[] {
  const rows: BenchRow[] = []
  const shapes: BenchRow['shape'][] = ['random', 'full']
  const kinds: BenchRow['amounts'][] = ['usdc', 'wide']
  for (let n = 3; n <= 8; n++) {
    shapes.forEach((shape, s) => {
      kinds.forEach((amounts, a) => {
        const next = generator(1 + n + 16 * s + 32 * a)
        const times: number[] = []
        let checksum = 0n
        for (let g = 0; g < graphs; g++) {
          const debts = randomGroup(next, n, shape, amounts)
          let result: Cancellation = { cancel: [], total: 0n }
          const start = now()
          for (let r = 0; r < repeats; r++) result = cancelCycles(n, debts)
          times.push((now() - start) / repeats)
          checksum += result.total
        }
        times.sort((x, y) => x - y)
        rows.push({
          n,
          shape,
          amounts,
          graphs,
          p50Ms: percentile(times, 0.5),
          p95Ms: percentile(times, 0.95),
          maxMs: times[times.length - 1],
          checksum: checksum.toString(),
        })
      })
    })
  }
  return rows
}

/** The smallest positive step of a clock over 10,000 consecutive reads. */
export function timerResolutionMs(now: () => number = () => performance.now()): number {
  let smallest = Infinity
  let last = now()
  for (let i = 0; i < 10_000; i++) {
    const t = now()
    if (t > last && t - last < smallest) smallest = t - last
    last = t
  }
  return smallest
}

const FRIENDS = 5

/** Synthetic week among five friends: shared expenses over seven days, netted to one tab per pair. */
export function weekOfDebts(seed: number): Debt[] {
  const next = generator(seed)
  const owed = Array.from({ length: FRIENDS }, () => new Array<bigint>(FRIENDS).fill(0n))
  for (let day = 0; day < 7; day++) {
    for (let e = 3 + below(next, 6); e > 0; e--) {
      const payer = below(next, FRIENDS)
      const price = BigInt(5_000_000 + below(next, 60_000_000))
      const others = Array.from({ length: FRIENDS }, (_, i) => i).filter((i) => i !== payer)
      for (let i = others.length - 1; i > 0; i--) {
        const j = below(next, i + 1)
        ;[others[i], others[j]] = [others[j], others[i]]
      }
      const sharers = 2 + below(next, 4)
      for (const debtor of others.slice(0, sharers - 1)) owed[debtor][payer] += price / BigInt(sharers)
    }
  }
  const debts: Debt[] = []
  for (let a = 0; a < FRIENDS; a++) {
    for (let b = a + 1; b < FRIENDS; b++) {
      const net = owed[a][b] - owed[b][a]
      if (net === 0n) continue
      const [debtor, creditor] = net > 0n ? [a, b] : [b, a]
      debts.push({ id: `${debtor}>${creditor}`, debtor, creditor, amount: net > 0n ? net : -net })
    }
  }
  return debts
}

const spread = (values: number[]): Spread => {
  const sorted = [...values].sort((x, y) => x - y)
  return { p10: percentile(sorted, 0.1), p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9) }
}

/** Cancellation and simplification statistics over synthetic weeks (week `i` uses seed `seed + i`). */
export function summariseWeeks(weeks = 1000, seed = 1): WeekStats {
  const cancelled: number[] = []
  const before: number[] = []
  const afterNetting: number[] = []
  const afterSimplify: number[] = []
  let weeksWithCycle = 0
  for (let i = 0; i < weeks; i++) {
    const debts = weekOfDebts(seed + i)
    const result = cancelCycles(FRIENDS, debts)
    const rest = remaining(debts, result.cancel)
    const value = debts.reduce((sum, debt) => sum + debt.amount, 0n)
    if (result.total > 0n) weeksWithCycle++
    cancelled.push(value > 0n ? Number((result.total * 10_000n) / value) / 100 : 0)
    before.push(debts.length)
    afterNetting.push(rest.length)
    afterSimplify.push(simplify(FRIENDS, rest).length)
  }
  return {
    weeks,
    weeksWithCycle,
    valueCancelledPct: spread(cancelled),
    tabsBefore: spread(before),
    tabsAfterNetting: spread(afterNetting),
    transfersAfterSimplify: spread(afterSimplify),
  }
}
