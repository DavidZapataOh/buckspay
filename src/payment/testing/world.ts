import { ed25519 } from '@noble/curves/ed25519.js'
import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { withRecordableOutputs } from '../../keys/salt'
import vectors from '../../../anchor/crates/protocol/tests/vectors/v1.json'
import {
  type BondTicket,
  checkIssueStep,
  content,
  encodeIssueBody,
  envelope,
  type Issue,
  interval,
  MAX_NOTE_LIFE,
  issueSlot,
  type Attester,
  type Receiver,
  type Output,
  type Owner,
  ScopeKind,
  scopeHash,
  type Signed,
  type Spend,
  encodeSpendBody,
  Flags,
  ticketMessage,
  walkChain,
} from '../../protocol'
import { PAY_LIMITS } from '../../features/pay/limits'
import type { PaymentRequest } from '../messages'
import type { PayContext } from '../preflight'
import { planRespend, type HeldOutput } from '../respend'

export const NOTE_DOMAIN = hexToBytes(vectors.domain.note)
export const TICKET_DOMAIN = hexToBytes(vectors.domain.ticket)
export const MINT = new Uint8Array(32).fill(0x55)

export type Party = { secret: Uint8Array; key: Uint8Array }
export function party(seed: number): Party {
  const secret = new Uint8Array(32).fill(seed)
  return { secret, key: p256.getPublicKey(secret, true) }
}

const ATTESTER_SECRET = new Uint8Array(32).fill(0x42)
export const PROGRAM = hexToBytes(vectors.domain.program_id)
export const NOW = 1_800_000_000
export const ATTESTER: Attester = {
  id: 7,
  authority: new Uint8Array(32).fill(0x43),
  mint: MINT,
  stake: 10n ** 15n,
  key: ed25519.getPublicKey(ATTESTER_SECRET),
  prevKey: new Uint8Array(32),
  prevTrustedUntil: 0,
  revoked: [new Uint8Array(32), new Uint8Array(32)],
  syncedAt: NOW,
  active: true,
  relied: 0n,
}

/** Signs like the device does: the salt is changed until the output has a record address. */
export function signIssue(payer: Party, issue: Issue): Signed<Issue> {
  let draws = 0
  const message = withRecordableOutputs(
    issue,
    (salt) => ({ ...issue, salt }),
    (candidate) => checkIssueStep(NOTE_DOMAIN, PROGRAM, candidate),
    () => sha256(Uint8Array.of(++draws)).slice(0, 16),
  )
  const [start, end] = interval(message)
  const bytes = envelope(NOTE_DOMAIN, issueSlot(message.lockSeq, start, end), content(encodeIssueBody(message)))
  return { message, signature: p256.sign(bytes, payer.secret, { prehash: true, lowS: true, format: 'compact' }) }
}

export function makeTicket(
  fields: Omit<BondTicket, 'signature' | 'attester' | 'validUntil'> & { attester?: number; validUntil?: number },
): BondTicket {
  const unsigned: BondTicket = {
    ...fields,
    attester: fields.attester ?? ATTESTER.id,
    validUntil: fields.validUntil ?? NOW + 2 * 86_400,
    signature: new Uint8Array(64),
  }
  return { ...unsigned, signature: ed25519.sign(ticketMessage(TICKET_DOMAIN, unsigned), ATTESTER_SECRET) }
}

export function receiverFor(me: Party, over: Partial<Receiver> = {}): Receiver {
  return {
    noteDomain: NOTE_DOMAIN,
    program: PROGRAM,
    ticketDomain: TICKET_DOMAIN,
    attesters: [ATTESTER],
    me: { type: 'device', key: me.key },
    now: NOW,
    minWindow: 3600,
    maxNoteLife: MAX_NOTE_LIFE,
    acceptCategory: false,
    acceptAuthorities: [],
    ...over,
  }
}

const SEC = 86_400
const GENEROUS = 10n ** 12n

/** A note issued by `from` to `to` that `to` holds: the issue, the issuer's ticket and nothing else. */
export function heldNote(o: {
  from: Party
  to: Party
  amount: bigint
  hopsLeft?: number
  expiry?: number
  flags?: number
  scope?: Owner
}): HeldOutput {
  const authority: Owner | undefined =
    ((o.flags ?? 0) & Flags.AuthorityOnly) !== 0
      ? (o.scope ?? { type: 'account', address: new Uint8Array(32).fill(9) })
      : undefined
  const issue = signIssue(o.from, {
    issuer: o.from.key,
    mint: MINT,
    lockSeq: 1,
    cumEnd: o.amount,
    salt: new Uint8Array(16),
    owner: { type: 'device', key: o.to.key },
    amount: o.amount,
    caveats: {
      expiry: o.expiry ?? NOW + 5 * SEC,
      hopsLeft: o.hopsLeft ?? 3,
      flags: o.flags ?? 0,
      scopeKind: authority ? ScopeKind.Authority : o.scope ? ScopeKind.Merchant : ScopeKind.Any,
      scope: authority ? scopeHash(authority) : o.scope ? scopeHash(o.scope) : new Uint8Array(20),
    },
  })
  const ticket = makeTicket({
    device: o.from.key,
    mint: MINT,
    lockSeq: 1,
    bond: GENEROUS,
    backing: GENEROUS,
    lockUntil: NOW + 60 * SEC,
  })
  const [output] = walkChain(NOTE_DOMAIN, issue, []).last
  return { outputId: output.id, output, bundle: { issue, spends: [], tickets: [ticket] } }
}

/** A `PayContext` for `me` with one lock of `bond` and a ticket valid for two days from `now`. */
export function payCtx(
  me: Party,
  o: { bond?: bigint; now?: number; ticketValidUntil?: number; lockUntil?: number } = {},
): PayContext {
  const now = o.now ?? NOW
  const bond = o.bond ?? GENEROUS
  let draws = 0
  return {
    now,
    me: me.key,
    noteDomain: NOTE_DOMAIN,
    program: PROGRAM,
    locks: [
      {
        lockSeq: 3,
        mint: MINT,
        bond,
        backing: GENEROUS,
        lockUntil: o.lockUntil ?? now + 60 * SEC,
        nextCumEnd: 0n,
        ticket: makeTicket({
          device: me.key,
          mint: MINT,
          lockSeq: 3,
          bond,
          backing: GENEROUS,
          lockUntil: o.lockUntil ?? now + 60 * SEC,
          validUntil: o.ticketValidUntil ?? now + 2 * SEC,
        }),
      },
    ],
    tokens: new Map([[bytesToHex(MINT), { symbol: 'USDC', decimals: 6 }]]),
    limits: PAY_LIMITS,
    salt: () => sha256(Uint8Array.of(++draws)).slice(0, 16),
    knownReceivers: new Set(),
    paidToday: 0n,
    paidRequests: new Set(),
  }
}

export function requestTo(payee: Party | Owner, amount: bigint, o: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    owner: 'type' in payee ? payee : { type: 'device', key: payee.key },
    mint: MINT,
    amount,
    now: NOW,
    minWindow: 3600,
    minHops: 1,
    attesters: [ATTESTER.id],
    memo: '',
    witness: 'none',
    ...o,
  }
}

/** Signs a spend of `input` with the party's test key (low-S), like `signSpend` of `src/keys`. */
export function signSpendWith(p: Party, input: Output, spend: Spend): Uint8Array {
  const bytes = envelope(NOTE_DOMAIN, input.id, content(encodeSpendBody(spend)))
  return p256.sign(bytes, p.secret, { prehash: true, lowS: true, format: 'compact' })
}

/** The plan of a held note of 5 USDC re-spent by `me` to `bob`: a `Spend2` leaving `change`, or a `Spend1` when it is 0. */
export function respendPlan({ change }: { kind: 'spend1' | 'spend2'; change: bigint }) {
  const me = party(2)
  const result = planRespend(
    requestTo(party(3), 5_000_000n - change),
    [heldNote({ from: party(1), to: me, amount: 5_000_000n })],
    payCtx(me),
  )
  if (!result.ok) throw new Error(result.reason)
  return result.plan
}
