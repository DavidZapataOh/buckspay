import { ed25519 } from '@noble/curves/ed25519.js'
import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hexToBytes } from '@noble/hashes/utils.js'
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
  type Signed,
  ticketMessage,
} from '../../protocol'

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
