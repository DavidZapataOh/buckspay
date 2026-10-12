import { ed25519 } from '@noble/curves/ed25519.js'
import { equalBytes } from '@noble/curves/utils.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  decodeJoin,
  encodeIou,
  encodeJoin,
  encodeStatement,
  type NettingStatement,
  nettingAddress,
  statementContent,
  statementEnvelope,
  verifyCoSigned,
  verifyEd25519,
  verifyJoin,
} from '../../protocol'
import type { GroupWire } from '../../transport/nearby/group'
import { fromCanonical, toBytes32 } from '../rewards/secrets-poseidon'
import { buildStatement, type PairSlot } from './build'
import { HOST, type Invite, SessionChannel } from './channel'
import { cancelCycles, type Debt } from './cycles'
import { encodeWitness, saltFor, type Slot, SLOTS, slotIndex } from './digest'
import { AbortReason, type Proposal, type SessionMessage, type SignedRosterEntry, type TabEntry } from './messages'
import {
  EXPIRES_SECS,
  GRIND_SECS,
  peersOf,
  review,
  SIGN_MARGIN_SECS,
  type SessionDeps,
  type SessionOutcome,
  withTimeout,
  checkFinal,
} from './member'
import { Inbox, sealMessage } from './session-io'
import {
  abandonSession,
  adoptFinal,
  agreedWith,
  createSession,
  mineFrom,
  pursueRecord,
  Role,
  storeProof,
} from './session-store'

export const MAX_DUE_SECS = 90 * 86_400
const MAX_MEMBERS = 7
const NO_PROOF = new Uint8Array(256)

export type HostDeps = SessionDeps & {
  wire: GroupWire
  /** The 08-03 proving job. */
  prove: (session: Uint8Array, witness: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>
  /** Resolves when the person presses "Start netting". */
  start: Promise<void>
  /** Whether the record address of a candidate statement is usable; the program's own derivation by default. */
  recordable?: (statement: NettingStatement, attempt: number) => boolean
}

type Member = { endpoint: string; index: number; join: SignedRosterEntry['join']; key: Uint8Array }

const abs = (value: bigint) => (value < 0n ? -value : value)
const NEVER = 2 ** 31 - 1

/** The table's host: gathers the tabs, cancels the cycles, proposes, and collects the approvals. */
export async function runHost(deps: HostDeps, invite: Invite, signal: AbortSignal): Promise<SessionOutcome> {
  const { db, wire } = deps
  const channel = new SessionChannel(invite, HOST, () => deps.now() * 1000)
  let n = 0
  const inbox = new Inbox(wire, channel, () => (n ? [n] : []))
  const done = (outcome: SessionOutcome): SessionOutcome => {
    inbox.close()
    deps.onEvent({ type: 'ended', outcome })
    return outcome
  }
  const secret = deps.random(32)
  const ephemeral = ed25519.getPublicKey(secret)
  await createSession(db, {
    session: invite.session,
    role: Role.Host,
    myIndex: 0,
    ephemeralSecret: secret,
    now: deps.now(),
  })
  const body = encodeJoin({ session: invite.session, ephemeral, key: deps.deviceKey })
  const ownJoin = { body, signature: await deps.signIou(body) }
  const members: Member[] = []
  const send = async (to: number, message: SessionMessage) => wire.send(await sealMessage(channel, message), to)
  // A member that already left cannot be told anything; the session goes on without notifying it.
  const sendAll = async (message: SessionMessage) => {
    for (const m of members) await send(m.index, message).catch(() => undefined)
  }
  const abort = async (reason: number) => {
    await sendAll({ type: 'Abort', reason })
  }
  const abandon = async (reason: number, notify = true): Promise<SessionOutcome> => {
    if (notify) await abort(reason)
    await abandonSession(db, invite.session, deps.now())
    return done({ status: 'abandoned', reason })
  }

  const stop = new AbortController()
  signal.addEventListener('abort', () => stop.abort())
  void deps.start.then(() => stop.abort())
  for (;;) {
    const got = await inbox.take((m) => m.message.type === 'Join', NEVER, stop.signal)
    if (got === 'aborted' || got === 'timeout') break
    if ('gone' in got) {
      const at = members.findIndex((m) => m.endpoint === got.gone)
      if (at >= 0) members.splice(at, 1)
      continue
    }
    if (got.message.type !== 'Join') continue
    const joined = got.message.join
    let decoded
    try {
      decoded = decodeJoin(joined.body)
    } catch {
      await wire.drop(got.endpoint)
      continue
    }
    const fresh = ![...members.map((m) => m.key), deps.deviceKey].some((k) => equalBytes(k, decoded.key))
    const eph = ![...members.map((m) => m.join.body.slice(34, 66)), ephemeral].some((k) =>
      equalBytes(k, decoded.ephemeral),
    )
    if (
      !equalBytes(decoded.session, invite.session) ||
      !verifyJoin(joined.body, joined.signature, deps.domains.iou) ||
      !fresh ||
      !eph ||
      members.length >= MAX_MEMBERS
    ) {
      await wire.drop(got.endpoint)
      continue
    }
    const index = members.length + 1
    members.push({ endpoint: got.endpoint, index, join: joined, key: decoded.key })
    inbox.adopt(got.endpoint, index)
    deps.onEvent({ type: 'joined', count: members.length + 1 })
    for (const row of await agreedWith(db, decoded.key, 3)) {
      if (row.proof) {
        await send(index, { type: 'Final', signatures: row.signatures, proof: row.proof })
      }
    }
  }
  if (signal.aborted) return abandon(AbortReason.Cancelled)
  n = members.length + 1
  if (n < 2) return abandon(AbortReason.NothingToNet, false)

  const entries = new Map<number, TabEntry[]>()
  const mineNow = await mineFrom(db, {
    index: 0,
    session: invite.session,
    mint: deps.mint,
    deviceKey: deps.deviceKey,
    ephemeral,
  })
  entries.set(
    0,
    mineNow.tabs.map((t) => ({
      state: t.state,
      salt: toBytes32(saltFor(t.secret, invite.session)),
      debt: abs(t.balance),
      peerOwesSender: t.balance > 0n,
      pending: t.pending,
    })),
  )
  while (entries.size < n) {
    const got = await inbox.take(
      (m) =>
        m.message.type === 'Tabs' &&
        !entries.has(m.sender === 0xff ? (members.find((x) => x.endpoint === m.endpoint)?.index ?? -1) : m.sender),
      deps.timeouts.tabs,
      signal,
    )
    if (got === 'timeout') return abandon(AbortReason.Timeout)
    if (got === 'aborted') return abandon(AbortReason.Cancelled)
    if ('gone' in got) return abandon(AbortReason.MemberLeft)
    if (got.message.type !== 'Tabs') continue
    const who = members.find((m) => m.endpoint === got.endpoint)
    if (who) entries.set(who.index, got.message.tabs)
  }

  const keyOf = [deps.deviceKey, ...members.map((m) => m.key)]
  const byTab = new Map<string, { sender: number; entry: TabEntry }[]>()
  for (const [sender, tabs] of entries) {
    for (const entry of tabs) {
      const id = bytesToHex(entry.state.iou.tab)
      byTab.set(id, [...(byTab.get(id) ?? []), { sender, entry }])
    }
  }
  const debts: Debt[] = []
  const pairs: PairSlot[] = []
  const agreed: { debt: Debt; slot: Slot; debtor: number; creditor: number }[] = []
  for (const [id, sides] of byTab) {
    if (sides.length !== 2 || sides[0].sender === sides[1].sender) continue
    const [a, b] = sides
    const iou = a.entry.state.iou
    const ends = [keyOf[a.sender], keyOf[b.sender]]
    const sameParties = ends.some((k) => equalBytes(k, iou.debtor)) && ends.some((k) => equalBytes(k, iou.creditor))
    const consistent =
      equalBytes(encodeIou(iou), encodeIou(b.entry.state.iou)) &&
      equalBytes(a.entry.salt, b.entry.salt) &&
      a.entry.debt === b.entry.debt &&
      a.entry.peerOwesSender !== b.entry.peerOwesSender &&
      !a.entry.pending &&
      !b.entry.pending &&
      a.entry.debt > 0n
    const late = iou.due !== 0 && iou.due > deps.now() + MAX_DUE_SECS
    if (!sameParties || !consistent || late || !equalBytes(iou.mint, deps.mint)) continue
    if (!verifyCoSigned(a.entry.state, deps.domains.iou) || !verifyCoSigned(b.entry.state, deps.domains.iou)) continue
    const [debtor, creditor] = a.entry.peerOwesSender ? [b.sender, a.sender] : [a.sender, b.sender]
    const debt: Debt = { id, debtor, creditor, amount: a.entry.debt }
    debts.push(debt)
    const [i, j] = [Math.min(debtor, creditor), Math.max(debtor, creditor)]
    const slot: Slot = {
      tab: iou.tab,
      seq: iou.seq,
      dir: debtor === i ? 0 : 1,
      debt: a.entry.debt,
      cancel: 0n,
      salt: fromCanonical(a.entry.salt, 'salt'),
    }
    agreed.push({ debt, slot, debtor, creditor })
    pairs.push({ i, j, slot })
  }
  const joinOf = (m: number): SignedRosterEntry => ({ index: m, join: m === 0 ? ownJoin : members[m - 1].join })
  const rosterOf = (m: number): SignedRosterEntry[] => {
    const wanted = new Set<number>([m])
    for (const p of pairs) if (p.i === m || p.j === m) wanted.add(p.i === m ? p.j : p.i)
    return [...wanted].sort((x, y) => x - y).map(joinOf)
  }
  const cancellation = debts.length ? cancelCycles(n, debts) : { cancel: [] as bigint[], total: 0n }
  if (cancellation.total === 0n) {
    for (const m of members) await send(m.index, { type: 'Roster', entries: rosterOf(m.index) }).catch(() => undefined)
    await abort(AbortReason.NothingToNet)
    await abandonSession(db, invite.session, deps.now())
    return done({ status: 'nothing', peers: peersOf(rosterOf(0), 0) })
  }
  agreed.forEach((a, k) => {
    a.slot.cancel = cancellation.cancel[k]
  })

  let built: ReturnType<typeof buildStatement> | null = null
  for (let k = 0; k < GRIND_SECS; k++) {
    const candidate = buildStatement(
      {
        session: invite.session,
        mint: deps.mint,
        participants: n,
        total: cancellation.total,
        expires: deps.now() + EXPIRES_SECS + k,
        ephemeral: [ephemeral, ...members.map((m) => m.join.body.slice(34, 66))],
      },
      pairs,
    )
    const usable = deps.recordable
      ? deps.recordable(candidate.statement, k)
      : nettingAddress(deps.programId, statementContent(candidate.statement)) !== null
    if (usable) {
      built = candidate
      deps.onEvent({ type: 'grind', tries: k + 1 })
      break
    }
  }
  if (!built) return abandon(AbortReason.Timeout)
  const { statement, digests } = built
  const slots28: (Slot | null)[] = Array(SLOTS).fill(null)
  for (const { i, j, slot } of pairs) slots28[slotIndex(i, j)] = slot

  const slotsOf = (m: number) =>
    pairs
      .filter((p) => p.i === m || p.j === m)
      .map((p) => ({ slot: slotIndex(p.i, p.j), baseSeq: p.slot.seq, cancel: p.slot.cancel }))
      .sort((x, y) => x.slot - y.slot)
  const proposalFor = (m: number): Proposal => ({ statement, digests, slots: slotsOf(m) })
  for (const m of members) {
    await send(m.index, { type: 'Roster', entries: rosterOf(m.index) })
    await send(m.index, { type: 'Proposal', proposal: proposalFor(m.index) })
  }
  const proving = deps.prove(invite.session, encodeWitness(statement, slots28), stop.signal)
  proving.catch(() => undefined)

  const own = await review(deps, invite, 0, proposalFor(0), rosterOf(0), secret)
  if (!own.ok) {
    await abort(AbortReason.Refused)
    return done(own.outcome)
  }
  const signatures: Uint8Array[] = Array.from({ length: n }, () => new Uint8Array(64))
  signatures[0] = own.signature
  const have = new Set<number>([0])
  const message = statementEnvelope(statement, deps.domains.netting)
  const pending: SessionOutcome = { status: 'pending', expires: statement.expires }
  while (have.size < n) {
    const got = await inbox.take(
      (m) => m.message.type === 'Approve' || m.message.type === 'Abort',
      deps.timeouts.consent,
      signal,
    )
    if (got === 'timeout') return (await abort(AbortReason.Timeout), done(pending))
    if (got === 'aborted') return (await abort(AbortReason.Cancelled), done(pending))
    if ('gone' in got) {
      // A member that signed and then lost the link has already sent its approval or is about to.
      await inbox.settle()
      const left = members.find((m) => m.endpoint === got.gone)
      if (left && (have.has(left.index) || inbox.has((m) => m.endpoint === got.gone && m.message.type === 'Approve')))
        continue
      return (await abort(AbortReason.MemberLeft), done(pending))
    }
    if (got.message.type === 'Abort') return (await abort(got.message.reason), done(pending))
    if (got.message.type !== 'Approve') continue
    const who = members.find((m) => m.endpoint === got.endpoint)
    if (!who || have.has(who.index) || !verifyEd25519(statement.ephemeral[who.index], message, got.message.signature))
      continue
    signatures[who.index] = got.message.signature
    have.add(who.index)
  }

  const proved = await withTimeout(
    proving.catch(() => null),
    deps.timeouts.final,
  )
  let proof = proved === 'timeout' || proved === null ? NO_PROOF : proved
  const finalDeps = { domains: deps.domains, now: deps.now, verify: deps.verifyProof }
  const check = await adoptFinal(db, finalDeps, invite.session, encodeStatement(statement), { signatures, proof })
  deps.onEvent({ type: 'agreed', proof: check.proof })
  await sendAll({ type: 'Final', signatures, proof })
  if (deps.record) await pursueRecord(db, {}, invite.session, deps.record)
  const outcome: SessionOutcome = { status: 'agreed', proof: check.proof, view: own.view }
  const deadline = statement.expires - SIGN_MARGIN_SECS
  while (check.proof === 'missing' && proof === NO_PROOF && deps.now() < deadline && !signal.aborted) {
    const again = await deps.prove(invite.session, encodeWitness(statement, slots28), stop.signal).catch(() => null)
    if (!again) {
      await new Promise((r) => setTimeout(r, deps.timeouts.tabs))
      continue
    }
    proof = again
    const verified = await checkFinal(statement, signatures, proof, {
      domains: deps.domains,
      verifyProof: deps.verifyProof,
    })
    await storeProof(db, invite.session, proof)
    await sendAll({ type: 'Final', signatures, proof })
    deps.onEvent({ type: 'final', proof: verified.proof })
    break
  }
  return done(outcome)
}
