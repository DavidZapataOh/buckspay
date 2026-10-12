import { ed25519 } from '@noble/curves/ed25519.js'
import {
  DEVNET_GENESIS_HASH,
  domain,
  encodeStatement,
  type NettingStatement,
  nettingAddress,
  Purpose,
  statementContent,
  statementEnvelope,
} from '../../../protocol'
import { appliedNettings, listTabs } from '../../debts/store'
import { IOU_DOMAIN, MINT, PROGRAM } from '../../debts/testing'
import { buildStatement, type PairSlot, rootBytes } from '../build'
import { cancelCycles, type Debt } from '../cycles'
import { saltFor, type Slot, slotIndex } from '../digest'
import { EXPIRES_SECS, GRIND_SECS, type MyTabs, pairOf } from '../member'
import type { Proposal, SignedRosterEntry } from '../messages'
import { mineFrom } from '../session-store'
import { markPending, NOW, openTabBetween, type Person, person, tabSecretOf } from './people'

export type TriangleOptions = {
  people?: number
  due?: Record<string, number>
  dbFailOn?: (sql: string, count: number) => boolean
  pending?: string[]
}

export type SignedRoster = SignedRosterEntry[]
export type Built = { proposal: Proposal; rosters: SignedRoster[]; ephemeralSecrets: Uint8Array[] }
export type Change = {
  cancel?: Record<string, bigint>
  debt?: Record<string, bigint>
  expires?: number
  mint?: Uint8Array
  swapEphemeral?: [number, Uint8Array]
  digestOverride?: Record<number, Uint8Array>
}

const SESSION = new Uint8Array(32).fill(0x5e)
const U = 1_000_000n
const NETTING_DOMAIN = domain(Purpose.Netting, DEVNET_GENESIS_HASH, PROGRAM)

type TabSpec = { name: string; debtor: number; creditor: number; amount: bigint }

export type Fixture = Awaited<ReturnType<typeof assemble>>

async function assemble(options: TriangleOptions, onCurve: boolean) {
  const count = options.people ?? 3
  const people: Person[] = []
  for (let i = 0; i < count; i++) people.push(await person(i, { dbFailOn: options.dbFailOn }))
  const specs: TabSpec[] = [
    { name: 'A>B', debtor: 0, creditor: 1, amount: 10n * U },
    { name: 'B>C', debtor: 1, creditor: 2, amount: 7n * U },
    { name: 'C>A', debtor: 2, creditor: 0, amount: 5n * U },
  ]
  if (count > 3) specs.push({ name: 'D>A', debtor: 3, creditor: 0, amount: 1n * U })
  const tabs = new Map<string, Uint8Array>()
  for (const s of specs) {
    const [a, b] = [people[s.debtor], people[s.creditor]]
    tabs.set(
      s.name,
      await openTabBetween(a, b, { amount: s.amount, debtor: a, creditor: b, due: options.due?.[s.name] }),
    )
    if (options.pending?.includes(s.name)) for (const p of [a, b]) await markPending(p, tabs.get(s.name)!, 1)
  }
  const debts: Debt[] = specs.map((s) => ({ id: s.name, debtor: s.debtor, creditor: s.creditor, amount: s.amount }))
  const optimum = cancelCycles(count, debts)
  const secrets = new Map(specs.map((s) => [s.name, tabSecretOf(tabs.get(s.name)!)]))

  const rostersFor = (statementEphemeral: Uint8Array[]): SignedRoster[] =>
    people.map((me) => {
      const wanted = new Set<number>([me.index])
      for (const s of specs)
        if (s.debtor === me.index || s.creditor === me.index) wanted.add(s.debtor === me.index ? s.creditor : s.debtor)
      void statementEphemeral
      return [...wanted].sort((x, y) => x - y).map((index) => ({ index, join: people[index].signedJoin(SESSION) }))
    })

  const slotsOf = (pairs: PairSlot[], m: number) =>
    pairs
      .filter((p) => p.i === m || p.j === m)
      .map((p) => ({ slot: slotIndex(p.i, p.j), baseSeq: p.slot.seq, cancel: p.slot.cancel }))
      .sort((a, b) => a.slot - b.slot)

  const build = (change: Change, expires: number): Built => {
    const cancelOf = (s: TabSpec, i: number) => change.cancel?.[s.name] ?? optimum.cancel[i]
    const pairs: PairSlot[] = specs.map((s, k) => {
      const [i, j] = [Math.min(s.debtor, s.creditor), Math.max(s.debtor, s.creditor)]
      const slot: Slot = {
        tab: tabs.get(s.name)!,
        seq: 1,
        dir: s.debtor === i ? 0 : 1,
        debt: change.debt?.[s.name] ?? s.amount,
        cancel: cancelOf(s, k),
        salt: saltFor(secrets.get(s.name)!, SESSION),
      }
      return { i, j, slot }
    })
    const ephemeral = people.map((p) => p.ephemeral)
    if (change.swapEphemeral) ephemeral[change.swapEphemeral[0]] = change.swapEphemeral[1]
    const total = pairs.reduce((sum, p) => sum + p.slot.cancel, 0n)
    const built = buildStatement(
      { session: SESSION, mint: change.mint ?? MINT, participants: count, total, expires, ephemeral },
      pairs,
    )
    let { statement } = built
    let digests = built.digests
    if (change.digestOverride) {
      digests = digests.map((d, i) => change.digestOverride![i] ?? d)
      statement = { ...statement, root: rootBytes(digests) }
    }
    return {
      proposal: { statement, digests, slots: slotsOf(pairs, 1) },
      rosters: rostersFor(ephemeral),
      ephemeralSecrets: people.map((p) => p.ephemeralSecret),
      pairs,
    } as Built & { pairs: PairSlot[] }
  }

  const offCurve = (expires: number) =>
    nettingAddress(PROGRAM, statementContent(build({}, expires).proposal.statement)) !== null
  let expires = NOW + EXPIRES_SECS
  for (let k = 0; ; k++) {
    expires = NOW + EXPIRES_SECS + k
    if (offCurve(expires) !== onCurve) break
    if (k > GRIND_SECS * 8) throw new Error('no expires found')
  }
  const built = build({}, expires)
  const withPairs = (b: Built) => (b as Built & { pairs: PairSlot[] }).pairs

  return {
    people,
    session: SESSION,
    mint: MINT,
    now: NOW,
    built,
    deps: { domains: { iou: IOU_DOMAIN, netting: NETTING_DOMAIN }, programId: PROGRAM },
    statementBytes: encodeStatement(built.proposal.statement),
    mineOf: async (index: number): Promise<MyTabs> =>
      mineFrom(people[index].db, {
        index,
        session: SESSION,
        mint: MINT,
        deviceKey: people[index].party.key,
        ephemeral: people[index].ephemeral,
      }),
    rebuild: (change: Change) => {
      if (change.expires !== undefined) return build(change, change.expires)
      for (let k = 0; ; k++) {
        const candidate = build(change, NOW + EXPIRES_SECS + k)
        if (nettingAddress(PROGRAM, statementContent(candidate.proposal.statement)) !== null) return candidate
      }
    },
    sign: async (statement: NettingStatement) =>
      people.map((p) => ed25519.sign(statementEnvelope(statement, NETTING_DOMAIN), p.ephemeralSecret)),
    leavesOf: (index: number): Slot[] =>
      withPairs(built)
        .filter((p) => p.i === index || p.j === index)
        .sort((a, b) => slotIndex(a.i, a.j) - slotIndex(b.i, b.j))
        .map((p) => p.slot),
    forMember: (b: Built, index: number): Built => ({
      ...b,
      proposal: { ...b.proposal, slots: slotsOf((b as Built & { pairs: PairSlot[] }).pairs, index) },
    }),
    rosterOf: (index: number): SignedRoster => built.rosters[index],
    rosterOfBuilt: (b: Built, index: number): SignedRoster => b.rosters[index],
    contentOf: (statement: NettingStatement) => statementContent(statement),
    tabOfSlot: (index: number, slot: number) => specOfSlot(index, slot).tab,
    debtorOfSlot: (index: number, slot: number) => people[specOfSlot(index, slot).spec.debtor].party.key,
    appliedNettingsOf: async (index: number) => {
      const out = []
      for (const { row } of await listTabs(people[index].db))
        out.push(...(await appliedNettings(people[index].db, row.tab)))
      return out
    },
  }

  function specOfSlot(index: number, slot: number) {
    const [i, j] = pairOf(slot)
    const other = i === index ? j : i
    const spec = specs.find(
      (s) => (s.debtor === index && s.creditor === other) || (s.creditor === index && s.debtor === other),
    )!
    return { spec, tab: tabs.get(spec.name)! }
  }
}

/** A→B 10, B→C 7, C→A 5 (6-decimal units); every cancel 5; total 15; B is people[1]; four people add D→A 1. */
export const triangle = (options: TriangleOptions = {}) => assemble(options, false)

/** The same triangle with an `expires` whose record address is on the curve. */
export const onCurveProposal = () => assemble({}, true)
