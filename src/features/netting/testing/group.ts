import { equalBytes } from '@noble/curves/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js'
import {
  DEVNET_GENESIS_HASH,
  decodeStatement,
  domain,
  type NettingStatement,
  nettingAddress,
  publicInputs,
  sessionField,
  Purpose,
  statementContent,
} from '../../../protocol'
import type { GroupWire, LinkEvent } from '../../../transport/nearby/group'
import {
  appliedNettings,
  coSignedStates,
  latestFinal,
  repayStatuses,
  saveCoSigned,
  tabNow,
  takeNextSeq,
} from '../../debts/store'
import { balance, intentChange, TabRefusal, type TabChange } from '../../debts/tab'
import { coSigned, contentOf, IOU_DOMAIN, iouOf, MINT, PROGRAM } from '../../debts/testing'
import { buildStatement, type PairSlot, rootBytes } from '../build'
import { HOST, JOINING, newInvite, type Invite, SessionChannel } from '../channel'
import { cancelCycles } from '../cycles'
import { digest, saltFor, type Slot, slotIndex } from '../digest'
import { runHost, type HostDeps } from '../host'
import {
  DEFAULT_TIMEOUTS,
  runMember,
  type ProposalView,
  type SessionDeps,
  type SessionEvent,
  type SessionOutcome,
  type SessionTimeouts,
} from '../member'
import { decodeMessage, encodeMessage, type Proposal } from '../messages'
import { NETTING_KEEP_SECS } from '../record'
import { listSessions, Status, sweepSessions, pursueRecord } from '../session-store'
import type { SessionPort } from '../session-port'
import { NOW, openTabBetween, type Person, person } from './people'
import { toBytes32 } from '../../rewards/secrets-poseidon'

export type TabSpec = {
  a: number
  b: number
  amount: bigint
  debtor: 'a' | 'b'
  due?: number | ((now: number) => number)
  extra?: { a?: bigint; b?: bigint }
}
export type Tap = { from: number; to: number; type: number; body: Uint8Array }
export type TapResult = undefined | null | { type?: number; body?: Uint8Array }
export type Clock = { now: number; advance(seconds: number): void }
export type Insider = (
  seal: (sender: number, type: number, body: Uint8Array, label?: string, when?: string) => Promise<void>,
) => Promise<void>

export type RigOptions = {
  timeouts?: Partial<SessionTimeouts>
  consent?: (index: number, view: ProposalView, clock: Clock) => boolean | Promise<boolean>
  prove?: HostDeps['prove']
  verify?: SessionDeps['verifyProof']
  skew?: Record<number, number>
  forceCurveTries?: number
}

/** Tests only: stands for the program's record and the RPC reads. */
export type ChainFake = {
  now: number
  advance(seconds: number): void
  record(content: Uint8Array): boolean
  historyReachesBack: boolean
  fund(content: Uint8Array): void
  nettingOutcome(statement: NettingStatement): Promise<'recorded' | 'void' | 'pending' | 'undecided'>
}

function seeded(seed: number): () => number {
  let state = seed | 0 || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}

const SEED_SHIFT = 1
const FAKE_TIMEOUTS: SessionTimeouts = { tabs: 150, consent: 400, final: 200 }
void DEFAULT_TIMEOUTS

const fakeProof = (statement: NettingStatement) => {
  const inputs = concatBytes(...publicInputs(statement))
  return concatBytes(inputs, inputs.slice().reverse()).slice(0, 256)
}
const statementOfWitness = (witness: Uint8Array) => decodeStatement(witness.slice(0, 111 + 32 * witness[66]))
const bootProve: HostDeps['prove'] = async (_s, witness) => fakeProof(statementOfWitness(witness))
const bootVerify: SessionDeps['verifyProof'] = async (_statement, proof) =>
  proof.length === 256 && proof.some((b) => b !== 0)

class Chain implements ChainFake {
  now: number
  historyReachesBack = true
  readonly records = new Map<string, number>()
  readonly expiresOf = new Map<string, number>()
  readonly funded = new Set<string>()
  constructor(start: number) {
    this.now = start
  }
  advance(seconds: number) {
    this.now += seconds
  }
  learn(statement: NettingStatement) {
    this.expiresOf.set(bytesToHex(statementContent(statement)), statement.expires)
  }
  record(content: Uint8Array) {
    const key = bytesToHex(content)
    const expires = this.expiresOf.get(key)
    if (expires === undefined || this.now >= expires || this.records.has(key)) return false
    this.records.set(key, this.now)
    return true
  }
  fund(content: Uint8Array) {
    this.funded.add(bytesToHex(content))
  }
  async nettingOutcome(statement: NettingStatement) {
    const key = bytesToHex(statementContent(statement))
    if (this.now < statement.expires) return this.records.has(key) ? 'recorded' : 'pending'
    if (this.now < statement.expires + NETTING_KEEP_SECS) return this.records.has(key) ? 'recorded' : 'void'
    if (!this.historyReachesBack) return 'undecided'
    return this.records.has(key) ? 'recorded' : 'void'
  }
}

class Link {
  readonly frames: ((frame: Uint8Array, from: string) => void)[] = []
  readonly links: ((event: LinkEvent) => void)[] = []
  backlog: { frame: Uint8Array; from: string }[] = []
}

const person_of = (endpoint: string) => Number(endpoint.slice(1))

class Wire implements GroupWire {
  readonly link = new Link()
  readonly identified = new Map<number, string>()
  dead = false
  constructor(
    readonly role: 'hub' | 'spoke',
    readonly mode = 'group' as const,
    private readonly net: Net,
    readonly me: number,
  ) {}
  async send(frame: Uint8Array, to?: number) {
    if (this.dead) throw new Error('link down')
    if (this.role === 'hub') {
      const endpoint = this.identified.get(to ?? -1)
      if (!endpoint || this.net.cutSet.has(person_of(endpoint))) throw new Error('member not connected')
      await this.net.route(0, person_of(endpoint), frame)
    } else {
      await this.net.route(this.me, 0, frame)
    }
  }
  async broadcast(frame: Uint8Array) {
    for (const [index] of this.identified) await this.send(frame, index)
  }
  identify(endpoint: string, index: number) {
    this.identified.set(index, endpoint)
  }
  onFrame(listener: (frame: Uint8Array, from: string) => void) {
    this.link.frames.push(listener)
    for (const { frame, from } of this.link.backlog.splice(0)) listener(frame, from)
    return () => void this.link.frames.splice(this.link.frames.indexOf(listener), 1)
  }
  onLink(listener: (event: LinkEvent) => void) {
    this.link.links.push(listener)
    return () => void this.link.links.splice(this.link.links.indexOf(listener), 1)
  }
  spokes() {
    return this.role === 'hub' ? this.net.live().length : 1
  }
  deliver(frame: Uint8Array, from: string) {
    if (this.dead) return
    if (this.link.frames.length === 0) this.link.backlog.push({ frame, from })
    else this.link.frames.forEach((l) => l(frame, from))
  }
  down(endpoint: string) {
    this.link.links.forEach((l) => l({ type: 'down', endpoint }))
  }
  async drop(endpoint: string) {
    this.net.dropped.push(endpoint)
    this.net.cutSet.add(person_of(endpoint))
    this.down(endpoint)
    this.net.spoke(person_of(endpoint))?.down('E0')
  }
  async close() {
    this.dead = true
  }
}

class Net {
  readonly cutSet = new Set<number>()
  hostCut = false
  readonly dropped: string[] = []
  readonly frames: Tap[] = []
  readonly taps: ((f: Tap) => TapResult)[] = []
  readonly hub: Wire
  readonly spokes: Wire[] = []
  duplicate = false
  corrupter: ((f: Tap) => boolean) | null = null
  readonly resealers = new Map<number, SessionChannel>()
  onFrame: ((tap: Tap) => void) | null = null
  constructor(
    private readonly invite: Invite,
    private readonly clockMs: () => number,
    members: number[],
  ) {
    this.hub = new Wire('hub', 'group', this, 0)
    for (const p of members) this.spokes[p] = new Wire('spoke', 'group', this, p)
  }
  spoke(p: number) {
    return this.spokes[p]
  }
  live() {
    return this.spokes.flatMap((w, p) => (w && !this.cutSet.has(p) ? [p] : []))
  }
  tap(fn: (f: Tap) => TapResult) {
    this.taps.push(fn)
  }
  cut(p: number) {
    this.cutSet.add(p)
    this.hub.down(`E${p}`)
    this.spokes[p]?.down('E0')
  }
  cutHost() {
    this.hostCut = true
    this.spokes.forEach((w, p) => w && !this.cutSet.has(p) && w.down('E0'))
  }
  private async decode(frame: Uint8Array, sender: number) {
    const probe = new SessionChannel(this.invite, sender, this.clockMs)
    try {
      const opened = await probe.open(frame, 'tap')
      return { type: opened.type, body: opened.body }
    } catch {
      return null
    }
  }
  async route(from: number, to: number, frame: Uint8Array): Promise<void> {
    if (this.hostCut || this.cutSet.has(from === 0 ? to : from)) return
    const sealer = (sender: number) => {
      let channel = this.resealers.get(sender)
      if (!channel) {
        channel = new SessionChannel(this.invite, sender === 0xff ? JOINING : sender, () => this.clockMs() + 3_600_000)
        this.resealers.set(sender, channel)
      }
      return channel
    }
    let out = frame
    const decoded = await this.decode(frame, frame[0] === 0xff ? JOINING : frame[0])
    if (decoded) {
      const tap: Tap = { from, to, type: decoded.type, body: decoded.body }
      this.frames.push(tap)
      this.onFrame?.(tap)
      for (const fn of this.taps) {
        const result = fn(tap)
        if (result === null) return
        if (result) out = await sealer(frame[0]).seal(result.type ?? tap.type, result.body ?? tap.body)
      }
    }
    if (this.corrupter && decoded && this.corrupter({ from, to, type: decoded.type, body: decoded.body })) {
      this.corrupter = null
      out = Uint8Array.from(out, (b, i) => (i === out.length - 1 ? b ^ 1 : b))
    }
    const copies = this.duplicate ? 2 : 1
    for (let k = 0; k < copies; k++) {
      if (to === 0) this.hub.deliver(out, `E${from}`)
      else this.spokes[to]?.deliver(out, 'E0')
    }
  }
}

export type Rig = ReturnType<typeof makeRig> extends Promise<infer R> ? R : never

type Shared = { people: Person[]; tabs: Uint8Array[]; clock: Clock; chain: Chain; counter: { n: number } }

async function makeRig(n: number, specs: TabSpec[], options: RigOptions = {}, shared?: Shared, active?: number[]) {
  const people = shared?.people ?? (await Promise.all(Array.from({ length: n }, (_, i) => person(i))))
  const clock: Clock = shared?.clock ?? {
    now: NOW,
    advance(seconds) {
      this.now += seconds
    },
  }
  const chain = shared?.chain ?? new Chain(NOW)
  const counter = shared?.counter ?? { n: 0 }
  const tabs: Uint8Array[] = shared?.tabs ?? []
  if (!shared) {
    for (const s of specs) {
      const [pa, pb] = [people[s.a], people[s.b]]
      const [debtor, creditor] = s.debtor === 'a' ? [pa, pb] : [pb, pa]
      const due = typeof s.due === 'function' ? s.due(NOW) : s.due
      const extra = s.extra?.a ?? s.extra?.b
      tabs.push(await openTabBetween(pa, pb, { amount: s.amount, debtor, creditor, due, extraOnA: extra }))
    }
  }
  const run = ++counter.n
  const rng = seeded(run * 7919 + 1 + SEED_SHIFT)
  const random = (len: number) => Uint8Array.from({ length: len }, () => Math.floor(rng() * 256))
  const invite = newInvite(random)
  const participants = active ?? people.map((_, i) => i)
  // A real proof takes seconds, not the fraction of a second the fakes need.
  const timeouts = { ...FAKE_TIMEOUTS, ...(options.prove ? { final: 120_000 } : {}), ...options.timeouts }
  const events: SessionEvent[] = []
  const net = new Net(
    invite,
    () => clock.now * 1000,
    participants.filter((p) => p !== participants[0]),
  )
  const netDomain = domain(Purpose.Netting, DEVNET_GENESIS_HASH, PROGRAM)
  const insiders: [number, Insider][] = []
  const joinWaiters: [number, () => void][] = []
  const joinedAtLeast = (count: number) =>
    Promise.race([
      new Promise<void>((resolve) => joinWaiters.push([count, resolve])),
      new Promise<void>((resolve) => setTimeout(resolve, 50)),
    ])
  let startNow: () => void = () => undefined
  const start = new Promise<void>((resolve) => {
    startNow = resolve
  })
  const phoneNow = (i: number) => () => clock.now
  const skewed = (i: number) => () => clock.now + (options.skew?.[i] ?? 0)

  const links = new Map<number, SessionPort>()
  const depsFor = (i: number): SessionDeps => ({
    db: people[i].db,
    now: phoneNow(i),
    random,
    domains: { iou: IOU_DOMAIN, netting: netDomain },
    programId: PROGRAM,
    mint: MINT,
    deviceKey: people[i].party.key,
    signIou: (body) => people[i].signIou(body),
    verifyProof: options.verify ?? bootVerify,
    consent: async (view) => (options.consent ? options.consent(i, view, clock) : true),
    onLink: (port) => void links.set(i, port),
    onEvent: (event) => {
      events.push(event)
      if (i === participants[0] && event.type === 'joined') {
        joinWaiters.filter(([count]) => event.count >= count).forEach(([, resolve]) => resolve())
        if (event.count >= participants.length - net.cutSet.size) startNow()
      }
    },
    timeouts,
  })

  const rig = {
    clock,
    chain: chain as ChainFake,
    people,
    links,
    invite,
    events,
    net: {
      tap: (fn: (f: Tap) => TapResult) => net.tap(fn),
      cut: (i: number) => net.cut(i),
      cutHost: () => net.cutHost(),
      frames: net.frames,
      dropped: net.dropped,
      insider: (index: number, fn: Insider) => void insiders.push([index, fn]),
      duplicateEveryFrame: () => {
        net.duplicate = true
      },
      corrupt: (pred: (f: Tap) => boolean) => {
        net.corrupter = pred
      },
      captured: () => [...net.frames],
      inject: async (f: Tap) => {
        void f
      },
    },
    endpointOf: (i: number) => `E${i}`,
    contentOf: (statement: NettingStatement) => statementContent(statement),
    restartHostChannel: async () => undefined,
    decodeProposal: (body: Uint8Array): Proposal => {
      const message = decodeMessage(0x13, body)
      if (message.type !== 'Proposal') throw new Error('not a proposal')
      return message.proposal
    },
    async run(): Promise<SessionOutcome[]> {
      net.onFrame = (tap) => {
        if (tap.type === 0x13) chain.learn(decodeStatement(tap.body.slice(0, 111 + 32 * tap.body[66])))
      }
      const controller = new AbortController()
      const [host, ...rest] = participants
      const hostDeps: HostDeps = {
        ...depsFor(host),
        wire: net.hub,
        prove: options.prove ?? bootProve,
        start,
        recordable:
          options.forceCurveTries === undefined
            ? undefined
            : (statement, attempt) =>
                attempt >= options.forceCurveTries! && nettingAddress(PROGRAM, statementContent(statement)) !== null,
      }
      const insiderRuns: Promise<void>[] = []
      for (const [index, fn] of insiders) {
        const previous = net.onFrame
        let fired = false
        net.onFrame = (tap) => {
          previous?.(tap)
          if (!fired && tap.type === 0x14 && tap.from === index) {
            fired = true
            insiderRuns.push(
              fn(async (sender, type, body, label) => {
                if (label && label !== 'to-host') return
                const forged = new SessionChannel(invite, sender, () => clock.now * 1000)
                await net.route(index, 0, await forged.seal(type, body))
              }),
            )
          }
        }
      }
      const members: Promise<SessionOutcome>[] = []
      for (const [position, p] of rest.entries()) {
        members.push(runMember({ ...depsFor(p), wire: net.spokes[p] }, invite, controller.signal))
        await joinedAtLeast(position + 2)
      }
      const outcomes = await Promise.all([runHost(hostDeps, invite, controller.signal), ...members])
      await Promise.all(insiderRuns)
      return outcomes
    },
    async rerun(without: number[]) {
      return makeRig(
        n,
        specs,
        options,
        { people, tabs, clock, chain, counter },
        participants.filter((p) => !without.includes(p)),
      )
    },
    async sweepAll() {
      for (let i = 0; i < people.length; i++) {
        await sweepSessions(people[i].db, { nettingOutcome: (s) => chain.nettingOutcome(s) }, skewed(i)(), {
          restart: false,
        })
      }
    },
    async recordFrom(index: number) {
      const row = (await listSessions(people[index].db, 50)).find((r) => equalBytes(r.session, invite.session))
      if (!row || row.status !== Status.Agreed) return
      await pursueRecord(people[index].db, {}, invite.session, {
        submitNetting: async (statement) => {
          chain.record(statementContent(decodeStatement(statement)))
          return { signature: 'recorded', pending: false }
        },
        quoteNettingRecord: async () => ({ lamports: 1, sponsor: 'sponsor', expiresAt: 0 }),
        payNettingRecord: async () => 'payment',
        recordNettingPaying: async () => ({ signature: 'v1' }),
      })
    },
    async balance(index: number, tab: number) {
      const id = tabs[tab]
      const db = people[index].db
      return balance(
        people[index].party.key,
        await coSignedStates(db, id),
        await appliedNettings(db, id),
        await repayStatuses(db, id),
      )
    },
    async sumBalances(index: number) {
      let sum = 0n
      for (let t = 0; t < specs.length; t++)
        if ([specs[t].a, specs[t].b].includes(index)) sum += await rig.balance(index, t)
      return sum
    },
    async statusOf(index: number) {
      const row = (await listSessions(people[index].db, 50)).find((r) => equalBytes(r.session, invite.session))
      return row ? row.status : -1
    },
    async bilateralChange(index: number, tab: number, delta: bigint) {
      void index
      const state = await nextChange(tab, delta)
      for (const p of [specs[tab].a, specs[tab].b]) await saveCoSigned(people[p].db, state, clock.now)
    },
    oneSidedOffer(from: number, tab: number, delta: bigint) {
      const made = nextChange(tab, delta, from)
      return {
        async cosign(by: number) {
          const state = await made
          for (const p of [from, by]) await saveCoSigned(people[p].db, state, clock.now)
        },
      }
    },
    async clear(index: number, tab: number): Promise<{ change: TabChange } | { refused: 'pending' }> {
      const spec = specs[tab]
      const peer = people[index === spec.a ? spec.b : spec.a]
      const me = people[index].party.key
      const now = await tabNow(people[index].db, me, tabs[tab])
      try {
        const change: TabChange = intentChange(
          me,
          peer.party.key,
          { kind: 'clear', amount: 0n, due: 0, memo: null },
          now,
        )
        return { change }
      } catch (error) {
        if (error instanceof TabRefusal && error.reason === 'pending') return { refused: 'pending' }
        throw error
      }
    },
    recomputeRoot: (statement: NettingStatement, digests: Uint8Array[]) => {
      void statement
      return rootBytes(digests)
    },
    recomputeDigest: (statement: NettingStatement, p: number) =>
      toBytes32(digest(sessionField(statement), p, slotsOf(allPairs()))),
    regrindExpires: (body: Uint8Array, k: number) => {
      const proposal = rig.decodeProposal(body)
      const fields = { ...proposal.statement, expires: proposal.statement.expires + k }
      const built = buildStatement(fields, allPairs())
      return encodeMessage({
        type: 'Proposal',
        proposal: { ...proposal, statement: built.statement, digests: built.digests },
      }).body
    },
    withCancel: (body: Uint8Array, slotPos: number, cancel: bigint) => {
      const proposal = rig.decodeProposal(body)
      const slots = proposal.slots.map((s, i) => (i === slotPos ? { ...s, cancel } : s))
      return encodeMessage({ type: 'Proposal', proposal: { ...proposal, slots } }).body
    },
    simplify: async (approve: (index: number) => boolean): Promise<{ paid: boolean; messageId?: Uint8Array }> => {
      void approve
      throw new Error('simplification is exercised by the remainder flow')
    },
  }

  function allPairs(): PairSlot[] {
    const debts = specs.map((s, i) => ({
      id: String(i),
      debtor: s.debtor === 'a' ? s.a : s.b,
      creditor: s.debtor === 'a' ? s.b : s.a,
      amount: s.amount,
    }))
    const cancel = cancelCycles(people.length, debts).cancel
    return specs.map((s, k) => {
      const [d, c] = debts[k].debtor === s.a ? [s.a, s.b] : [s.b, s.a]
      const [i, j] = [Math.min(d, c), Math.max(d, c)]
      const secret = tabSecret(k)
      const slot: Slot = {
        tab: tabs[k],
        seq: 1,
        dir: d === i ? 0 : 1,
        debt: s.amount,
        cancel: cancel[k],
        salt: saltFor(secret, invite.session),
      }
      return { i, j, slot }
    })
  }

  function tabSecret(k: number) {
    return sha256(concatBytes(tabs[k], Uint8Array.of(1)))
  }

  function slotsOf(pairs: PairSlot[]): (Slot | null)[] {
    const out: (Slot | null)[] = Array(28).fill(null)
    for (const p of pairs) out[slotIndex(p.i, p.j)] = p.slot
    return out
  }

  async function nextChange(tab: number, delta: bigint, from?: number) {
    const spec = specs[tab]
    const [debtorIndex, creditorIndex] = spec.debtor === 'a' ? [spec.a, spec.b] : [spec.b, spec.a]
    const [debtor, creditor] = delta > 0n ? [debtorIndex, creditorIndex] : [creditorIndex, debtorIndex]
    const db = people[from ?? spec.a].db
    const seq = await takeNextSeq(db, tabs[tab])
    const previous = (await latestFinal(db, tabs[tab]))!
    const iou = iouOf(seq, people[debtor].party.key, people[creditor].party.key, delta < 0n ? -delta : delta, {
      tab: tabs[tab],
      reference: contentOf(previous),
    })
    return coSigned(iou, people[debtor].party, people[creditor].party)
  }

  return rig
}

export const rig = (n: number, specs: TabSpec[], options?: RigOptions) => makeRig(n, specs, options)

/** Five friends, seven days, 3-8 expenses a day of 2-60 units split among 2-5 people; the running net of each pair is one tab. */
export function week(seed: number): TabSpec[] {
  const next = seeded(seed)
  const pick = (count: number) => Math.floor(next() * count)
  const owes = Array.from({ length: 5 }, () => Array<bigint>(5).fill(0n))
  for (let day = 0; day < 7; day++) {
    for (let e = 0, count = 3 + pick(6); e < count; e++) {
      const payer = pick(5)
      const group = new Set<number>([payer])
      for (const size = 2 + pick(4); group.size < size;) group.add(pick(5))
      const amount = BigInt(2 + pick(59)) * 1_000_000n
      const weights = [...group].map(() => BigInt(1 + pick(5)))
      const sum = weights.reduce((a, b) => a + b, 0n)
      ;[...group].forEach((p, k) => {
        if (p !== payer) owes[p][payer] += (amount * weights[k]) / sum
      })
    }
  }
  const specs: TabSpec[] = []
  for (let i = 0; i < 5; i++) {
    for (let j = i + 1; j < 5; j++) {
      const d = owes[i][j] - owes[j][i]
      if (d !== 0n) specs.push({ a: i, b: j, amount: d > 0n ? d : -d, debtor: d > 0n ? 'a' : 'b' })
    }
  }
  return specs
}

export { HOST }
