import { equalBytes } from '@noble/curves/utils.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  type CoSignedIou,
  decodeJoin,
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
import type { Proposal, SignedRosterEntry } from './messages'

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
