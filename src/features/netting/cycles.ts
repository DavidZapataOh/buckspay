export type Debt = { id: string; debtor: number; creditor: number; amount: bigint }
export type Cancellation = { cancel: bigint[]; total: bigint } // cancel[i] belongs to debts[i]
export type Transfer = { payer: number; payee: number; amount: bigint; via: number[] }
export const MAX_TOTAL = 2n ** 64n - 1n

const MAX_PARTICIPANTS = 64

type Arc = { from: number; to: number; debt: number; forward: boolean }

function validate(participants: number, debts: readonly Debt[]) {
  if (!Number.isInteger(participants) || participants < 1 || participants > MAX_PARTICIPANTS) {
    throw new RangeError(`participants must be an integer in 1..${MAX_PARTICIPANTS}`)
  }
  const ids = new Set<string>()
  for (const { id, debtor, creditor, amount } of debts) {
    const inRange = (index: number) => Number.isInteger(index) && index >= 0 && index < participants
    if (!inRange(debtor) || !inRange(creditor)) throw new RangeError(`debt ${id} names a participant out of range`)
    if (debtor === creditor) throw new RangeError(`debt ${id} has the same debtor and creditor`)
    if (amount < 0n || amount > MAX_TOTAL) throw new RangeError(`debt ${id} has an amount out of range`)
    if (ids.has(id)) throw new RangeError(`debt id ${id} is repeated`)
    ids.add(id)
  }
}

/**
 * Cancels debt around cycles so that every participant's net position stays the same. The result is a
 * circulation: for each participant, what is cancelled on debts it owes equals what is cancelled on debts owed
 * to it. `total` is the sum of `cancel` and never exceeds `maxTotal`; it is the maximum possible whenever it is at
 * most `maxTotal - participants`. Ties are broken by participant index, then id, so the result does not depend on
 * the order of `debts`. Throws RangeError on invalid input.
 */
export function cancelCycles(participants: number, debts: readonly Debt[], maxTotal: bigint = MAX_TOTAL): Cancellation {
  validate(participants, debts)
  if (maxTotal <= 0n || maxTotal > MAX_TOTAL) throw new RangeError('maxTotal must be in 1..2^64 - 1')

  const cancel = debts.map(() => 0n)
  const arcs: Arc[] = []
  debts.forEach((debt, debtIndex) => {
    if (debt.amount === 0n) return
    arcs.push({ from: debt.debtor, to: debt.creditor, debt: debtIndex, forward: true })
    arcs.push({ from: debt.creditor, to: debt.debtor, debt: debtIndex, forward: false })
  })
  arcs.sort((a, b) => a.from - b.from || a.to - b.to || compareIds(debts[a.debt].id, debts[b.debt].id))

  const capacity = (arc: Arc) => (arc.forward ? debts[arc.debt].amount - cancel[arc.debt] : cancel[arc.debt])
  const steps = participants
  let total = 0n

  for (;;) {
    const live = arcs.filter((arc) => capacity(arc) > 0n)
    const dist: number[][] = [new Array<number>(participants).fill(0)]
    const pred: (Arc | undefined)[][] = [new Array<Arc | undefined>(participants).fill(undefined)]
    for (let k = 1; k <= steps; k++) {
      const row = new Array<number>(participants).fill(Infinity)
      const via = new Array<Arc | undefined>(participants).fill(undefined)
      for (const arc of live) {
        const cost = dist[k - 1][arc.from] + (arc.forward ? -1 : 1)
        if (cost < row[arc.to]) {
          row[arc.to] = cost
          via[arc.to] = arc
        }
      }
      dist.push(row)
      pred.push(via)
    }

    let bestNum = 0
    let bestDen = 1
    let bestVertex = -1
    for (let v = 0; v < participants; v++) {
      if (dist[steps][v] === Infinity) continue
      let num = 0
      let den = 0
      for (let k = 0; k < steps; k++) {
        if (dist[k][v] === Infinity) continue
        const candNum = dist[steps][v] - dist[k][v]
        const candDen = steps - k
        if (den === 0 || candNum * den > num * candDen) {
          num = candNum
          den = candDen
        }
      }
      if (bestVertex < 0 || num * bestDen < bestNum * den) {
        bestNum = num
        bestDen = den
        bestVertex = v
      }
    }
    if (bestVertex < 0 || bestNum >= 0) break

    const cycle = extractCycle(pred, steps, bestVertex)
    let net = 0
    let room = MAX_TOTAL
    for (const arc of cycle) {
      net += arc.forward ? 1 : -1
      const cap = capacity(arc)
      if (cap < room) room = cap
    }
    const allowed = (maxTotal - total) / BigInt(net)
    const delta = room < allowed ? room : allowed
    if (delta === 0n) break
    for (const arc of cycle) cancel[arc.debt] += arc.forward ? delta : -delta
    total += delta * BigInt(net)
  }

  return { cancel, total }
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function extractCycle(pred: (Arc | undefined)[][], steps: number, end: number): Arc[] {
  const seenAt = new Map<number, number>()
  const walk: Arc[] = []
  let vertex = end
  for (let k = steps; ; k--) {
    const first = seenAt.get(vertex)
    if (first !== undefined) return walk.slice(first)
    seenAt.set(vertex, walk.length)
    const arc = pred[k][vertex] as Arc
    walk.push(arc)
    vertex = arc.from
  }
}

/** Credit minus debt of each participant. */
export function netPositions(participants: number, debts: readonly Debt[]): bigint[] {
  validate(participants, debts)
  const net = new Array<bigint>(participants).fill(0n)
  for (const { debtor, creditor, amount } of debts) {
    net[debtor] -= amount
    net[creditor] += amount
  }
  return net
}

/** The debts left after `cancel`: amount minus cancellation, zeros dropped, input order and ids kept. */
export function remaining(debts: readonly Debt[], cancel: readonly bigint[]): Debt[] {
  if (cancel.length !== debts.length) throw new RangeError('cancel must have one entry per debt')
  const left: Debt[] = []
  debts.forEach((debt, i) => {
    if (cancel[i] < 0n || cancel[i] > debt.amount) throw new RangeError(`cancellation of ${debt.id} is out of range`)
    const amount = debt.amount - cancel[i]
    if (amount > 0n) left.push({ ...debt, amount })
  })
  return left
}

/**
 * Settles an acyclic remainder with payments along existing tabs. Each transfer pays `amount` from `payer` to
 * `payee` (a path of any length) and reduces by `amount` every tab on the path payer, ...via, payee (`via` lists
 * the intermediate participants in order). Applying all transfers zeroes the remainder. At most one transfer per
 * tab of the remainder; at most `participants - 1` when the remainder's tabs form a forest. Parallel tabs of a
 * pair are added up. Throws RangeError on invalid input or on a cyclic remainder (possible only when the cap bound).
 */
export function simplify(participants: number, rest: readonly Debt[]): Transfer[] {
  validate(participants, rest)
  const tab = Array.from({ length: participants }, () => new Array<bigint>(participants).fill(0n))
  for (const { debtor, creditor, amount } of rest) tab[debtor][creditor] += amount

  const state = new Array<number>(participants).fill(0)
  const visit = (u: number) => {
    state[u] = 1
    for (let w = 0; w < participants; w++) {
      if (tab[u][w] === 0n) continue
      if (state[w] === 1) throw new RangeError('the remainder contains a cycle')
      if (state[w] === 0) visit(w)
    }
    state[u] = 2
  }
  for (let u = 0; u < participants; u++) if (state[u] === 0) visit(u)

  const transfers: Transfer[] = []
  for (;;) {
    const longest = new Array<number>(participants).fill(-1)
    const depth = (u: number): number => {
      if (longest[u] >= 0) return longest[u]
      let best = 0
      for (let w = 0; w < participants; w++) if (tab[u][w] > 0n) best = Math.max(best, 1 + depth(w))
      return (longest[u] = best)
    }
    let start = -1
    for (let u = 0; u < participants; u++) if (depth(u) > (start < 0 ? 0 : longest[start])) start = u
    if (start < 0) return transfers

    const path = [start]
    while (longest[path[path.length - 1]] > 0) {
      const u = path[path.length - 1]
      let next = 0
      while (tab[u][next] === 0n || longest[next] !== longest[u] - 1) next++
      path.push(next)
    }
    let amount = tab[path[0]][path[1]]
    for (let i = 1; i + 1 < path.length; i++) if (tab[path[i]][path[i + 1]] < amount) amount = tab[path[i]][path[i + 1]]
    for (let i = 0; i + 1 < path.length; i++) tab[path[i]][path[i + 1]] -= amount
    transfers.push({ payer: start, payee: path[path.length - 1], amount, via: path.slice(1, -1) })
  }
}
