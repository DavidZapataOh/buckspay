import { ed25519 } from '@noble/curves/ed25519.js'
import { equalBytes } from '@noble/curves/utils.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  type CoSignedIou,
  decodeJoin,
  decodeStatement,
  encodeJoin,
  encodeStatement,
  type NettingStatement,
  nettingAddress,
  ProtocolError,
  sessionField,
  statementContent,
  statementEnvelope,
  verifyEd25519,
  verifyJoin,
} from '../../protocol'
import { fromCanonical, toBytes32 } from '../rewards/secrets-poseidon'
import { rootBytes } from './build'
import { digest, type Slot, saltFor, SLOTS, slotIndex } from './digest'
import { lockTabs } from '../debts/store'
import type { NoteDb } from '../notes/db'
import type { GroupWire } from '../../transport/nearby/group'
import { type Invite, JOINING, SessionChannel } from './channel'
import { AbortReason, type Proposal, type SessionMessage, type SignedRosterEntry } from './messages'
import { Inbox, sealMessage } from './session-io'
import { type SessionPort, sessionPort } from './session-port'
import {
  abandonSession,
  adoptFinal,
  BaseTaken,
  createSession,
  listSessions,
  markApproved,
  markProposed,
  mineFrom,
  pursueRecord,
  type RecordPorts,
  Role,
  Status,
} from './session-store'

export const SIGN_MARGIN_SECS = 600
export const EXPIRES_SECS = 72 * 3600
export const GRIND_SECS = 64
export const EXPIRES_SKEW_SECS = 3600
export const MAX_SLOTS = 7

export type RefusalCode =
  | 'BadStatement'
  | 'WrongMint'
  | 'Expired'
  | 'NotInRoster'
  | 'DuplicateKey'
  | 'CounterpartyJoin'
  | 'AddressOnCurve'
  | 'UnknownTab'
  | 'PendingItem'
  | 'ExpiresTooFar'
  | 'StaleSeq'
  | 'WrongSlot'
  | 'CancelAboveDebt'
  | 'NetChanged'
  | 'TotalBelowMine'
  | 'DigestMismatch'
  | 'RootMismatch'
  | 'BaseSigned'
  | 'BadSignatures'

export class NettingRefusal extends Error {
  constructor(readonly code: RefusalCode) {
    super(code)
    this.name = 'NettingRefusal'
  }
}

export type SessionDomains = { iou: Uint8Array; netting: Uint8Array }

export type MyTab = {
  tab: Uint8Array
  peer: Uint8Array
  secret: Uint8Array
  finalSeq: number
  /** Signed: positive = the peer owes me. */
  balance: bigint
  pending: boolean
  due: number
  /** The latest co-signed state. */
  state: CoSignedIou
}

export type MyTabs = {
  index: number
  session: Uint8Array
  mint: Uint8Array
  deviceKey: Uint8Array
  ephemeral: Uint8Array
  tabs: MyTab[]
  /** `"tabHex:baseSeq"` to the session that signed that base, for sessions at approved, agreed or undecided. */
  signedBases: ReadonlyMap<string, string>
}

export type TabView = {
  tab: Uint8Array
  peerIndex: number
  direction: 'owesMe' | 'iOwe'
  amount: bigint
  cancel: bigint
  remaining: bigint
  due: number
}

export type ProposalView = {
  tabs: TabView[]
  netBefore: bigint
  netAfter: bigint
  participants: number
  total: bigint
  expires: number
}

const refuse = (ok: boolean, code: RefusalCode) => {
  if (!ok) throw new NettingRefusal(code)
}

const abs = (value: bigint) => (value < 0n ? -value : value)

/** The pair `(i, j)`, `i < j`, of a slot index; the inverse of `slotIndex`. */
export function pairOf(slot: number): [number, number] {
  let start = 0
  for (let i = 0; i < 7; i++) {
    const width = 7 - i
    if (slot < start + width) return [i, i + 1 + (slot - start)]
    start += width
  }
  throw new RangeError('slot')
}

type Entry = { index: number; key: Uint8Array; ephemeral: Uint8Array; signed: SignedRosterEntry }

function entriesOf(roster: SignedRosterEntry[]): Entry[] {
  return roster.map((signed) => {
    try {
      const join = decodeJoin(signed.join.body)
      return { index: signed.index, key: join.key, ephemeral: join.ephemeral, signed }
    } catch (error) {
      if (error instanceof ProtocolError) throw new NettingRefusal('CounterpartyJoin')
      throw error
    }
  })
}

function checkStatementShape(p: Proposal, mine: MyTabs) {
  try {
    encodeStatement(p.statement)
    fromCanonical(p.statement.root, 'root')
  } catch {
    throw new NettingRefusal('BadStatement')
  }
  refuse(p.digests.length === 8 && p.digests.every((d) => d.length === 32), 'BadStatement')
  refuse(p.slots.length <= MAX_SLOTS && p.slots.every((s) => s.slot < SLOTS), 'BadStatement')
  refuse(equalBytes(p.statement.session, mine.session), 'BadStatement')
  refuse(mine.index < p.statement.participants, 'BadStatement')
}

/**
 * Everything a member needs to be true before it signs; the first failing rule throws a `NettingRefusal`. Pure
 * apart from reading its arguments: a host cannot make a member sign anything this refuses.
 */
export function checkProposal(
  p: Proposal,
  roster: SignedRosterEntry[],
  mine: MyTabs,
  now: number,
  deps: { domains: SessionDomains; programId: Uint8Array },
): ProposalView {
  const { statement } = p
  checkStatementShape(p, mine)
  refuse(
    equalBytes(statement.mint, mine.mint) && mine.tabs.every((t) => equalBytes(t.state.iou.mint, statement.mint)),
    'WrongMint',
  )
  refuse(now < statement.expires - SIGN_MARGIN_SECS, 'Expired')
  refuse(statement.expires <= now + EXPIRES_SECS + GRIND_SECS + EXPIRES_SKEW_SECS, 'ExpiresTooFar')

  const entries = entriesOf(roster)
  const unique = (values: Uint8Array[] | number[]) =>
    new Set(values.map((v) => (typeof v === 'number' ? v : bytesToHex(v)))).size === values.length
  refuse(
    unique(entries.map((e) => e.index)) && unique(entries.map((e) => e.key)) && unique(entries.map((e) => e.ephemeral)),
    'DuplicateKey',
  )
  const own = entries.find((e) => e.index === mine.index)
  refuse(
    !!own &&
      equalBytes(own.key, mine.deviceKey) &&
      equalBytes(own.ephemeral, mine.ephemeral) &&
      equalBytes(own.ephemeral, statement.ephemeral[mine.index]),
    'NotInRoster',
  )
  for (const entry of entries) {
    refuse(
      entry.index < statement.participants &&
        equalBytes(decodeJoin(entry.signed.join.body).session, statement.session) &&
        equalBytes(entry.ephemeral, statement.ephemeral[entry.index]) &&
        verifyJoin(entry.signed.join.body, entry.signed.join.signature, deps.domains.iou),
      'CounterpartyJoin',
    )
  }
  for (const slot of p.slots) {
    const [i, j] = pairOf(slot.slot)
    if (j < statement.participants && (i === mine.index || j === mine.index)) {
      const peerIndex = i === mine.index ? j : i
      refuse(
        entries.some((e) => e.index === peerIndex),
        'CounterpartyJoin',
      )
    }
  }

  const seen = new Set<number>()
  const slots28: (Slot | null)[] = Array(SLOTS).fill(null)
  const views: TabView[] = []
  let credited = 0n
  let debited = 0n
  let owed = 0n
  for (const slot of p.slots) {
    const [i, j] = pairOf(slot.slot)
    refuse(j < statement.participants, 'UnknownTab')
    refuse(i === mine.index || j === mine.index, 'WrongSlot')
    const peerIndex = i === mine.index ? j : i
    const peer = entries.find((e) => e.index === peerIndex)
    const tab = peer && mine.tabs.find((t) => equalBytes(t.peer, peer.key))
    refuse(!!tab, 'UnknownTab')
    refuse(!seen.has(slot.slot), 'WrongSlot')
    seen.add(slot.slot)
    refuse(!tab!.pending, 'PendingItem')
    refuse(slot.baseSeq === tab!.finalSeq, 'StaleSeq')
    const debt = abs(tab!.balance)
    refuse(slot.cancel <= debt, 'CancelAboveDebt')
    const iOwe = tab!.balance < 0n
    if (iOwe) {
      debited += slot.cancel
      owed -= debt
    } else {
      credited += slot.cancel
      owed += debt
    }
    const iAmLower = mine.index < peerIndex
    slots28[slotIndex(Math.min(mine.index, peerIndex), Math.max(mine.index, peerIndex))] = {
      tab: tab!.tab,
      seq: tab!.finalSeq,
      dir: iAmLower === iOwe ? 0 : 1,
      debt,
      cancel: slot.cancel,
      salt: saltFor(tab!.secret, statement.session),
    }
    views.push({
      tab: tab!.tab,
      peerIndex,
      direction: iOwe ? 'iOwe' : 'owesMe',
      amount: debt,
      cancel: slot.cancel,
      remaining: debt - slot.cancel,
      due: tab!.due,
    })
  }
  refuse(statement.total >= debited, 'TotalBelowMine')
  refuse(credited === debited, 'NetChanged')
  const mineDigest = digest(sessionField(statement), mine.index, slots28)
  refuse(equalBytes(p.digests[mine.index], toBytes32(mineDigest)), 'DigestMismatch')
  refuse(equalBytes(rootBytes(p.digests), statement.root), 'RootMismatch')
  for (const slot of p.slots) {
    const [i, j] = pairOf(slot.slot)
    const tab = slots28[slotIndex(i, j)]!.tab
    refuse(!mine.signedBases.has(`${bytesToHex(tab)}:${slot.baseSeq}`), 'BaseSigned')
  }
  refuse(nettingAddress(deps.programId, statementContent(statement)) !== null, 'AddressOnCurve')
  return {
    tabs: views,
    netBefore: owed,
    netAfter: owed - credited + debited,
    participants: statement.participants,
    total: statement.total,
    expires: statement.expires,
  }
}

export type FinalCheck = { setComplete: true; proof: 'valid' | 'invalid' | 'missing' }

export const ZERO_PROOF_BYTE = 0

/**
 * The full set of strict Ed25519 signatures over the statement, in roster order, and what the verifier says of the
 * proof. An incomplete or wrong set throws `BadSignatures`; a zero proof is `missing` and is not verified.
 */
export async function checkFinal(
  statement: NettingStatement,
  signatures: Uint8Array[],
  proof: Uint8Array,
  deps: {
    domains: Pick<SessionDomains, 'netting'>
    verifyProof: (statement: NettingStatement, proof: Uint8Array) => Promise<boolean>
  },
): Promise<FinalCheck> {
  const message = statementEnvelope(statement, deps.domains.netting)
  refuse(
    signatures.length === statement.participants &&
      signatures.every((signature, i) => verifyEd25519(statement.ephemeral[i], message, signature)),
    'BadSignatures',
  )
  if (proof.every((byte) => byte === ZERO_PROOF_BYTE)) return { setComplete: true, proof: 'missing' }
  try {
    return { setComplete: true, proof: (await deps.verifyProof(statement, proof)) ? 'valid' : 'invalid' }
  } catch {
    return { setComplete: true, proof: 'invalid' }
  }
}

export type SessionTimeouts = { tabs: number; consent: number; final: number }
export const DEFAULT_TIMEOUTS: SessionTimeouts = { tabs: 60_000, consent: 600_000, final: 300_000 }

export type SessionEvent =
  | { type: 'joined'; count: number }
  | { type: 'phase'; status: number }
  | { type: 'grind'; tries: number }
  | { type: 'consent'; view: ProposalView }
  | { type: 'agreed'; proof: FinalCheck['proof'] }
  | { type: 'final'; proof: FinalCheck['proof'] }
  | { type: 'refused'; refusal: NettingRefusal['code'] }
  | { type: 'ended'; outcome: SessionOutcome }

/** Someone this phone has a tab with in the session: the index the host gave them and their device key. */
export type SessionPeer = { index: number; key: Uint8Array }

export const peersOf = (roster: readonly SignedRosterEntry[], me: number): SessionPeer[] =>
  roster.filter((e) => e.index !== me).map((e) => ({ index: e.index, key: decodeJoin(e.join.body).key }))

export type SessionOutcome =
  | { status: 'agreed'; proof: FinalCheck['proof']; view: ProposalView }
  | { status: 'pending'; expires: number }
  | { status: 'abandoned'; reason: number }
  | { status: 'nothing'; peers: SessionPeer[] }
  | { status: 'refused'; refusal: RefusalCode }

export type SessionDeps = {
  db: NoteDb
  now: () => number
  random: (n: number) => Uint8Array
  domains: SessionDomains
  programId: Uint8Array
  mint: Uint8Array
  /** The P-256 device key of this phone, compressed. */
  deviceKey: Uint8Array
  signIou: (body: Uint8Array) => Promise<Uint8Array>
  verifyProof: (statement: NettingStatement, proof: Uint8Array) => Promise<boolean>
  consent: (view: ProposalView) => Promise<boolean>
  onEvent: (event: SessionEvent) => void
  timeouts: SessionTimeouts
  /** When set, an agreed session is sent to the gateway as soon as it exists. */
  record?: RecordPorts
  /** Given the link of a session that ended with something left to pay; the caller closes it. */
  onLink?: (port: SessionPort) => void
}

export type Reviewed =
  { ok: true; signature: Uint8Array; view: ProposalView } | { ok: false; outcome: SessionOutcome; refused: boolean }

/**
 * Checks the proposal against this phone's own tabs, shows it, and signs the Ed25519 approval only after the person
 * said yes and the clock still leaves the margin. The bases, effects and signature are stored before the caller
 * sends anything (one transaction).
 */
export async function review(
  deps: SessionDeps,
  invite: { session: Uint8Array },
  index: number,
  proposal: Proposal,
  roster: SignedRosterEntry[],
  ephemeralSecret: Uint8Array,
): Promise<Reviewed> {
  const { db } = deps
  const abandon = async (outcome: SessionOutcome, refused: boolean): Promise<Reviewed> => {
    await abandonSession(db, invite.session, deps.now())
    return { ok: false, outcome, refused }
  }
  const mine = await mineFrom(db, {
    index,
    session: invite.session,
    mint: deps.mint,
    deviceKey: deps.deviceKey,
    ephemeral: ed25519.getPublicKey(ephemeralSecret),
  })
  let view: ProposalView
  try {
    view = checkProposal(proposal, roster, mine, deps.now(), deps)
  } catch (error) {
    if (!(error instanceof NettingRefusal)) throw error
    deps.onEvent({ type: 'refused', refusal: error.code })
    return abandon({ status: 'refused', refusal: error.code }, true)
  }
  const { statement } = proposal
  const slotted = proposal.slots.map((slot) => {
    const [i, j] = pairOf(slot.slot)
    const peer = mine.tabs.find((t) => t.peer && specifiesPeer(t, statement, roster, i === index ? j : i))!
    return { slot, tab: peer }
  })
  await lockTabs(
    db,
    invite.session,
    slotted.map((s) => s.tab.tab),
  )
  await markProposed(db, invite.session, {
    statement: encodeStatement(statement),
    joins: roster,
    digests: proposal.digests,
    leaves: [],
    myIndex: index,
    now: deps.now(),
  })
  deps.onEvent({ type: 'consent', view })
  const said = await withTimeout(deps.consent(view), deps.timeouts.consent)
  if (said !== true) return abandon({ status: 'abandoned', reason: AbortReason.Refused }, false)
  if (deps.now() >= statement.expires - SIGN_MARGIN_SECS) {
    deps.onEvent({ type: 'refused', refusal: 'Expired' })
    return abandon({ status: 'refused', refusal: 'Expired' }, true)
  }
  const signature = ed25519.sign(statementEnvelope(statement, deps.domains.netting), ephemeralSecret)
  const effects = slotted.map(({ slot, tab }) => ({
    tab: tab.tab,
    baseSeq: slot.baseSeq,
    debtor: tab.balance > 0n ? tab.peer : deps.deviceKey,
    cancel: slot.cancel,
  }))
  try {
    await markApproved(deps.db, invite.session, statementContent(statement), effects, signature, deps.now())
  } catch (error) {
    if (!(error instanceof BaseTaken)) throw error
    deps.onEvent({ type: 'refused', refusal: 'BaseSigned' })
    return abandon({ status: 'refused', refusal: 'BaseSigned' }, true)
  }
  deps.onEvent({ type: 'phase', status: Status.Approved })
  return { ok: true, signature, view }
}

function specifiesPeer(
  tab: MyTab,
  statement: NettingStatement,
  roster: SignedRosterEntry[],
  peerIndex: number,
): boolean {
  const entry = roster.find((e) => e.index === peerIndex)
  return !!entry && equalBytes(decodeJoin(entry.join.body).key, tab.peer) && statement.participants > peerIndex
}

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}

/** The member's side of a session; see `runHost` for the table's host. */
export async function runMember(
  deps: SessionDeps & { wire: GroupWire },
  invite: Invite,
  signal: AbortSignal,
): Promise<SessionOutcome> {
  const { db, wire } = deps
  const channel = new SessionChannel(invite, JOINING, () => deps.now() * 1000)
  const approved = async () => (await listSessions(db, 20)).filter((r) => r.status === Status.Approved && r.statement)
  let known = 0
  const pendingSizes = (await approved()).map((r) => decodeStatement(r.statement!).participants)
  const inbox = new Inbox(wire, channel, () => (known ? [known] : pendingSizes))
  const finish = (outcome: SessionOutcome): SessionOutcome => {
    if (deps.onLink && (outcome.status === 'nothing' || outcome.status === 'agreed'))
      deps.onLink(sessionPort({ wire, channel, inbox, me: channel.me }))
    else inbox.close()
    deps.onEvent({ type: 'ended', outcome })
    return outcome
  }
  const secret = deps.random(32)
  await createSession(db, {
    session: invite.session,
    role: Role.Member,
    myIndex: 0,
    ephemeralSecret: secret,
    now: deps.now(),
  })
  const ephemeral = ed25519.getPublicKey(secret)
  const body = encodeJoin({ session: invite.session, ephemeral, key: deps.deviceKey })
  const join = { body, signature: await deps.signIou(body) }
  const send = async (message: SessionMessage) => wire.send(await sealMessage(channel, message))
  const mine = await mineFrom(db, {
    index: 0,
    session: invite.session,
    mint: deps.mint,
    deviceKey: deps.deviceKey,
    ephemeral,
  })
  await send({ type: 'Join', join })
  await send({
    type: 'Tabs',
    tabs: mine.tabs.map((t) => ({
      state: t.state,
      salt: toBytes32(saltFor(t.secret, invite.session)),
      debt: t.balance < 0n ? -t.balance : t.balance,
      peerOwesSender: t.balance > 0n,
      pending: t.pending,
    })),
  })

  const aborted = async (reason: number) => {
    await abandonSession(db, invite.session, deps.now())
    return finish({ status: 'abandoned', reason })
  }
  let roster: SignedRosterEntry[] | null = null
  let index = 0
  let proposal: Proposal | null = null
  while (!proposal) {
    const got = await inbox.take(
      (m) => ['Roster', 'Proposal', 'Abort', 'Final'].includes(m.message.type),
      deps.timeouts.consent,
      signal,
    )
    if (got === 'timeout' || got === 'aborted') return aborted(AbortReason.Timeout)
    if ('gone' in got) return aborted(AbortReason.MemberLeft)
    const { message } = got
    if (message.type === 'Final') {
      for (const row of await approved()) {
        const statement = decodeStatement(row.statement!)
        if (statement.participants !== message.signatures.length) continue
        try {
          await adoptFinal(
            db,
            { domains: deps.domains, now: deps.now, verify: deps.verifyProof },
            row.session,
            row.statement!,
            {
              signatures: message.signatures,
              proof: message.proof,
            },
          )
          break
        } catch (error) {
          if (!(error instanceof NettingRefusal)) throw error
        }
      }
      continue
    }
    if (message.type === 'Abort') {
      return message.reason === AbortReason.NothingToNet
        ? (await abandonSession(db, invite.session, deps.now()),
          finish({ status: 'nothing', peers: roster ? peersOf(roster, index) : [] }))
        : aborted(message.reason)
    }
    if (message.type === 'Roster') {
      const own = message.entries.find((e) => equalBytes(decodeJoin(e.join.body).key, deps.deviceKey))
      if (!own) return aborted(AbortReason.Refused)
      index = own.index
      channel.assign(index)
      roster = message.entries
    } else if (roster && message.type === 'Proposal') {
      proposal = message.proposal
      known = proposal.statement.participants
    }
  }
  const reviewed = await review(deps, invite, index, proposal, roster!, secret)
  if (!reviewed.ok) {
    await send({ type: 'Abort', reason: AbortReason.Refused })
    return finish(reviewed.outcome)
  }
  await send({ type: 'Approve', signature: reviewed.signature })
  const statement = proposal.statement
  const pending: SessionOutcome = { status: 'pending', expires: statement.expires }
  for (;;) {
    const got = await inbox.take(() => true, deps.timeouts.consent + deps.timeouts.final, signal)
    if (got === 'timeout' || got === 'aborted' || 'gone' in got) return finish(pending)
    const { message } = got
    if (message.type === 'Abort') return finish(pending)
    if (message.type !== 'Final') continue
    try {
      const check = await adoptFinal(
        db,
        { domains: deps.domains, now: deps.now, verify: deps.verifyProof },
        invite.session,
        encodeStatement(statement),
        {
          signatures: message.signatures,
          proof: message.proof,
        },
      )
      deps.onEvent({ type: 'agreed', proof: check.proof })
      if (deps.record) await pursueRecord(db, {}, invite.session, deps.record)
      return finish({ status: 'agreed', proof: check.proof, view: reviewed.view })
    } catch (error) {
      if (!(error instanceof NettingRefusal)) throw error
      deps.onEvent({ type: 'refused', refusal: error.code })
    }
  }
}
