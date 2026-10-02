import { ed25519 } from '@noble/curves/ed25519.js'
import { p256 } from '@noble/curves/nist.js'
import { equalBytes } from '@noble/curves/utils.js'
import { concatBytes } from '@noble/hashes/utils.js'
import {
  admits,
  type BondTicket,
  type Caveats,
  CHALLENGE,
  change,
  checkBytes,
  checkIssue,
  checkOwnerBytes,
  checkU32,
  checkSpend,
  encodeIssueBody,
  encodeSpendBody,
  Flags,
  forHolder,
  GRACE,
  interval,
  type Issue,
  type IssueConflict,
  MAX_DEPTH,
  NO_LOCK,
  type Owner,
  permits,
  ProtocolError,
  ScopeKind,
  scopeHash,
  type Signed,
  type Spend,
  type SpendConflict,
  ticketMessage,
} from './codec'
import { content, envelope, issueSlot, messageId, outputId } from './hash'

export type Output = { id: Uint8Array; owner: Owner; amount: bigint; caveats: Caveats }
export type Attester = { id: number; key: Uint8Array }
/** What the receiving wallet trusts and requires. */
export type Receiver = {
  noteDomain: Uint8Array
  ticketDomain: Uint8Array
  attesters: Attester[]
  me: Owner
  now: number
  minWindow: number
  /** Accepts category-scoped payments; only for a receiver that checks categories itself. */
  acceptCategory: boolean
  /**
   * Account addresses of the authorities whose `AUTHORITY_ONLY` notes a device accepts, redeemable
   * only by paying them to that authority (a closed circuit the holder has joined).
   */
  acceptAuthorities: Uint8Array[]
}
/** A lock whose bond backs a payment, with the bond its ticket shows. */
export type Liability = { device: Uint8Array; lockSeq: number; bond: bigint }
/**
 * A chain that ends in a terminal account, as the program settles it: output 0 of its last message,
 * with the issue backing it.
 */
export type Settled = { output: Output; mint: Uint8Array; issuer: Uint8Array; lockSeq: number }
/**
 * An accepted payment: output 0 of the last message, the issue backing it, and the distinct locks
 * liable for it in chain order (the issuer's, then each lock a spender named), so the wallet can
 * keep a cumulative cap per lock. A spend without a lock adds none: the lock backing it, that of
 * the nearest earlier spend naming one or the issuer's, is already listed.
 */
export type Received = Settled & { liable: Liability[] }

const P256 = { prehash: true, lowS: true, format: 'compact' } as const

export function verifySignature(key: Uint8Array, message: Uint8Array, signature: Uint8Array) {
  checkBytes(signature, 64)
  if (!p256.utils.isValidPublicKey(key, true)) throw new ProtocolError('Signer')
  if (!p256.verify(signature, message, key, P256)) throw new ProtocolError('Signature')
}

function recover(message: Uint8Array, signature: Uint8Array, recovery: number): Uint8Array {
  try {
    return p256.recoverPublicKey(concatBytes(Uint8Array.of(recovery), signature), message, { prehash: true })
  } catch {
    throw new ProtocolError('Signature')
  }
}

/** The recovery id that makes `signature` over `message` recover `key`. */
export function recoveryId(key: Uint8Array, message: Uint8Array, signature: Uint8Array): number {
  const id = [0, 1, 2, 3].find((id) => {
    try {
      return equalBytes(recover(message, signature, id), key)
    } catch {
      return false
    }
  })
  if (id === undefined) throw new ProtocolError('Signature')
  return id
}

function recoverPair(a: Uint8Array, signatureA: Uint8Array, b: Uint8Array, signatureB: Uint8Array, recovery: number) {
  const key = recover(a, signatureA, recovery & 3)
  if (!equalBytes(recover(b, signatureB, recovery >> 2), key)) throw new ProtocolError('Signer')
  return key
}

export const recoverSpendSigner = (domain: Uint8Array, conflict: SpendConflict) =>
  recoverPair(
    envelope(domain, conflict.slot, conflict.contentA),
    conflict.signatureA,
    envelope(domain, conflict.slot, conflict.contentB),
    conflict.signatureB,
    conflict.recovery,
  )

export const recoverIssueSigner = (domain: Uint8Array, { a, b, recovery }: IssueConflict) =>
  recoverPair(
    envelope(domain, issueSlot(a.lockSeq, a.start, a.end), a.content),
    a.signature,
    envelope(domain, issueSlot(b.lockSeq, b.start, b.end), b.content),
    b.signature,
    recovery,
  )

export function verifySpendConflict(domain: Uint8Array, signer: Uint8Array, conflict: SpendConflict) {
  if (equalBytes(conflict.contentA, conflict.contentB)) throw new ProtocolError('Linkage')
  verifySignature(signer, envelope(domain, conflict.slot, conflict.contentA), conflict.signatureA)
  verifySignature(signer, envelope(domain, conflict.slot, conflict.contentB), conflict.signatureB)
}

export function verifyIssueConflict(domain: Uint8Array, issuer: Uint8Array, { a, b }: IssueConflict) {
  const overlaps =
    a.lockSeq === b.lockSeq &&
    !equalBytes(a.content, b.content) &&
    a.start < a.end &&
    b.start < b.end &&
    a.start < b.end &&
    b.start < a.end
  if (!overlaps) throw new ProtocolError('Linkage')
  verifySignature(issuer, envelope(domain, issueSlot(a.lockSeq, a.start, a.end), a.content), a.signature)
  verifySignature(issuer, envelope(domain, issueSlot(b.lockSeq, b.start, b.end), b.content), b.signature)
}

function checkOwner(owner: Owner) {
  if (owner.type === 'device' && !p256.utils.isValidPublicKey(owner.key, true)) throw new ProtocolError('Owner')
}

const sameOwner = (a: Owner, b: Owner) =>
  a.type === 'device'
    ? b.type === 'device' && equalBytes(a.key, b.key)
    : b.type === 'account' && equalBytes(a.address, b.address)

function verifyIssue(domain: Uint8Array, { message, signature }: Signed<Issue>): Output {
  checkIssue(message)
  checkOwner(message.owner)
  const [start, end] = interval(message)
  const env = envelope(domain, issueSlot(message.lockSeq, start, end), content(encodeIssueBody(message)))
  verifySignature(message.issuer, env, signature)
  return { id: outputId(messageId(env), 0), owner: message.owner, amount: message.amount, caveats: message.caveats }
}

/** Whether a spend of an output with these caveats is backed without the spender's lock. */
const unlocked = (input: Caveats) => (input.flags & (Flags.Delegated | Flags.AuthorityOnly)) !== 0

/** A `Spend1` to a terminal account: a settlement, which nothing spends further. */
const settles = ({ outputs }: Spend) => outputs.type === 'one' && outputs.owner.type === 'account'

function checkLock(input: Caveats, spend: Spend, payment: Caveats) {
  if (spend.lockSeq !== NO_LOCK) return
  if (!(unlocked(input) || settles(spend)) || (payment.flags & Flags.Delegated) !== 0) throw new ProtocolError('Lock')
}

/** The first output (owner, amount, caveats) and the change of a spend of `input`, if the rules of a hop allow them. */
function hop(input: Output, spend: Spend): [Owner, bigint, Caveats, Caveats | undefined] {
  const { outputs } = spend
  const [owner, amount, caveats]: [Owner, bigint, Caveats] =
    outputs.type === 'one'
      ? [outputs.owner, input.amount, outputs.caveats]
      : [outputs.owner0, outputs.amount0, outputs.caveats0]
  let changeCaveats: Caveats | undefined
  if (outputs.type === 'two') {
    changeCaveats = change(input.caveats)
    if (outputs.amount0 >= input.amount) throw new ProtocolError('Amount')
    if (!sameOwner(outputs.owner1, input.owner)) throw new ProtocolError('Change')
  }
  const rules = forHolder(input.caveats, input.owner)
  if (!permits(rules, caveats)) throw new ProtocolError('Attenuation')
  if (!admits(rules, owner)) throw new ProtocolError('Scope')
  checkLock(rules, spend, caveats)
  checkOwner(owner)
  return [owner, amount, caveats, changeCaveats]
}

function verifySpend(domain: Uint8Array, input: Output, { message, signature }: Signed<Spend>): Output[] {
  if (input.owner.type !== 'device') throw new ProtocolError('Owner')
  checkSpend(message)
  const env = envelope(domain, input.id, content(encodeSpendBody(message)))
  verifySignature(input.owner.key, env, signature)
  const [owner, amount, caveats, changeCaveats] = hop(input, message)
  const id = messageId(env)
  const first: Output = { id: outputId(id, 0), owner, amount, caveats }
  if (!changeCaveats) return [first]
  return [first, { id: outputId(id, 1), owner: input.owner, amount: input.amount - amount, caveats: changeCaveats }]
}

/**
 * Checks a spend of `input` before its holder signs it: `input` is a device's output that `spend`
 * names, the hop follows the rules receivers and the program apply, and `input` can still move at
 * `now`: until its expiry as a payment, until `expiry + GRACE` as a settlement.
 */
export function checkSpendStep(input: Output, spend: Spend, now: number) {
  checkU32(now)
  if (input.owner.type !== 'device') throw new ProtocolError('Owner')
  checkSpend(spend)
  if (!equalBytes(spend.input, input.id)) throw new ProtocolError('Linkage')
  if (now > input.caveats.expiry + (settles(spend) ? GRACE : 0)) throw new ProtocolError('Expired')
  hop(input, spend)
}

/**
 * Follows `spends` from the issue's output, each consuming either output of the previous message,
 * and returns output 0 of the last one. `check` sees each consumed output and its spend.
 */
function follow(
  domain: Uint8Array,
  issued: Output,
  spends: Signed<Spend>[],
  check: (input: Output, spend: Signed<Spend>) => void,
): Output {
  let holding = [issued]
  for (const spend of spends) {
    checkBytes(spend.message.input, 32)
    const input = holding.find((output) => equalBytes(output.id, spend.message.input))
    if (!input) throw new ProtocolError('Linkage')
    holding = verifySpend(domain, input, spend)
    check(input, spend)
  }
  return holding[0]
}

const settled = (issue: Issue, output: Output): Settled => ({
  output,
  mint: issue.mint,
  issuer: issue.issuer,
  lockSeq: issue.lockSeq,
})

/** A canonical encoding of a point in the prime-order subgroup, other than the identity. */
function primeOrder(bytes: Uint8Array): boolean {
  try {
    const point = ed25519.Point.fromBytes(bytes)
    return point.isTorsionFree() && !point.isSmallOrder()
  } catch {
    return false
  }
}

function attested(receiver: Receiver, ticket: BondTicket): boolean {
  const attester = receiver.attesters.find((attester) => attester.id === ticket.attester)
  if (!attester || !primeOrder(attester.key) || !primeOrder(ticket.signature.subarray(0, 32))) return false
  try {
    return ed25519.verify(ticket.signature, ticketMessage(receiver.ticketDomain, ticket), attester.key, {
      zip215: false,
    })
  } catch {
    return false
  }
}

/**
 * A payment carries at most one ticket per message and at most one per lock, so a sender cannot
 * make the receiver check more signatures than the chain needs.
 */
function checkBounds(spends: Signed<Spend>[], tickets: BondTicket[]) {
  if (spends.length > MAX_DEPTH) throw new ProtocolError('Depth')
  if (tickets.length > spends.length + 1) throw new ProtocolError('Ticket')
  const duplicate = tickets.some((a, i) =>
    tickets.slice(i + 1).some((b) => equalBytes(a.device, b.device) && a.lockSeq === b.lockSeq),
  )
  if (duplicate) throw new ProtocolError('Ticket')
}

/**
 * The ticket for `(device, lockSeq)`, which must be on `mint`, locked past the conflict window of
 * `expiry`, cover the liability and be signed by a trusted attester.
 */
function ticket(
  receiver: Receiver,
  tickets: BondTicket[],
  device: Owner,
  lockSeq: number,
  mint: Uint8Array,
  expiry: number,
  covers: (ticket: BondTicket) => boolean,
): Liability {
  const found = tickets.find(
    (ticket) => sameOwner({ type: 'device', key: ticket.device }, device) && ticket.lockSeq === lockSeq,
  )
  const valid =
    found !== undefined &&
    equalBytes(found.mint, mint) &&
    found.lockUntil >= expiry + GRACE + CHALLENGE &&
    covers(found) &&
    attested(receiver, found)
  if (!valid) throw new ProtocolError('Ticket')
  return { device: found.device, lockSeq, bond: found.bond }
}

function addLiability(liable: Liability[], lock: Liability) {
  if (!liable.some((l) => equalBytes(l.device, lock.device) && l.lockSeq === lock.lockSeq)) liable.push(lock)
}

/**
 * Whether `receiver.me` can redeem an output with `caveats`: a merchant scope must name it, an
 * authority scope must name it as an account or be an `AUTHORITY_ONLY` note of an authority the
 * device trusts, and a category needs a receiver that checks it.
 */
function redeemable(receiver: Receiver, caveats: Caveats): boolean {
  const rules = forHolder(caveats, receiver.me)
  if (rules.scopeKind === ScopeKind.Any) return true
  if (rules.scopeKind === ScopeKind.Category) return receiver.acceptCategory
  if (rules.scopeKind === ScopeKind.Authority) {
    if (receiver.me.type === 'account') return equalBytes(scopeHash(receiver.me), rules.scope)
    return (
      (rules.flags & Flags.AuthorityOnly) !== 0 &&
      receiver.acceptAuthorities.some((address) => equalBytes(scopeHash({ type: 'account', address }), rules.scope))
    )
  }
  return false
}

/**
 * Accepts a payment to `receiver.me`: output 0 of the last spend (or the issue's output when there
 * are no spends), never change, and only if `me` can redeem it. Stateless: the caller rejects
 * outputs and slots it has already accepted.
 */
export function verifyPayment(
  receiver: Receiver,
  issue: Signed<Issue>,
  spends: Signed<Spend>[],
  tickets: BondTicket[],
): Received {
  checkU32(receiver.now)
  checkU32(receiver.minWindow)
  checkOwnerBytes(receiver.me)
  for (const address of receiver.acceptAuthorities) checkBytes(address, 32)
  checkBounds(spends, tickets)
  const note = issue.message
  const issued = verifyIssue(receiver.noteDomain, issue)
  const liable: Liability[] = []
  const issuer: Owner = { type: 'device', key: note.issuer }
  addLiability(
    liable,
    ticket(
      receiver,
      tickets,
      issuer,
      note.lockSeq,
      note.mint,
      note.caveats.expiry,
      (t) => t.bond >= note.amount && t.backing >= note.cumEnd,
    ),
  )
  const output = follow(receiver.noteDomain, issued, spends, (input, spend) => {
    if (receiver.now > input.caveats.expiry) throw new ProtocolError('Expired')
    const { lockSeq } = spend.message
    if (lockSeq === NO_LOCK) {
      if (!unlocked(input.caveats)) throw new ProtocolError('Lock')
      return
    }
    addLiability(
      liable,
      ticket(receiver, tickets, input.owner, lockSeq, note.mint, input.caveats.expiry, (t) => t.bond >= input.amount),
    )
  })
  if (!sameOwner(output.owner, receiver.me)) throw new ProtocolError('Payee')
  if (!redeemable(receiver, output.caveats)) throw new ProtocolError('Scope')
  const stranded = output.owner.type === 'device' && output.caveats.hopsLeft === 0
  if (stranded || output.caveats.expiry < receiver.now + receiver.minWindow) throw new ProtocolError('Window')
  return { ...settled(note, output), liable }
}

/**
 * Verifies a chain whose output 0 of the last message is a terminal account, for settlement on
 * chain. It checks neither time nor tickets: the program bounds settlement by the output's expiry
 * and slashes locks on conflict.
 */
export function verifySettlement(domain: Uint8Array, issue: Signed<Issue>, spends: Signed<Spend>[]): Settled {
  const output = follow(domain, verifyIssue(domain, issue), spends, () => {})
  if (output.owner.type !== 'account') throw new ProtocolError('Payee')
  return settled(issue.message, output)
}
