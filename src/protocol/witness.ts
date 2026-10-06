import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { content, envelope } from './hash'
import { verifySignature } from './verify'

export const WITNESS_VERSION = 1
export const CHANNEL_ULTRASOUND = 1
export const CHANNEL_AUDIBLE = 2
export const CHALLENGE_BYTES = 8
export const BODY_BYTES = 112
export const EVIDENCE_BYTES = 176
export const CHALLENGE_MESSAGE_BYTES = 17
export const RESPONSE_MESSAGE_BYTES = 65

const CHALLENGE_TYPE = 0x11
const RESPONSE_TYPE = 0x12
const TAG_BYTES = 4
const KEY_BYTES = 33
const SIGNATURE_BYTES = 64
const TAG_LABEL = utf8ToBytes('BPW1-challenge')

export class WitnessError extends Error {
  constructor(readonly code: 'Malformed' | 'Signature' | 'Stale') {
    super(`Witness: ${code}`)
    this.name = 'WitnessError'
  }
}

export type WitnessBody = {
  paymentId: Uint8Array
  payerKey: Uint8Array
  receiverKey: Uint8Array
  challenge: Uint8Array
  issuedAt: number
  channel: number
}
export type WitnessEvidence = WitnessBody & { signature: Uint8Array }

const isKey = (key: Uint8Array) => key.length === KEY_BYTES && (key[0] === 2 || key[0] === 3)
const isChannel = (channel: number) => channel === CHANNEL_ULTRASOUND || channel === CHANNEL_AUDIBLE
const isU32 = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return out
}

function check(body: WitnessBody) {
  if (
    body.paymentId.length !== 32 ||
    !isKey(body.payerKey) ||
    !isKey(body.receiverKey) ||
    body.challenge.length !== CHALLENGE_BYTES ||
    !isU32(body.issuedAt) ||
    !isChannel(body.channel)
  )
    throw new WitnessError('Malformed')
}

/** Throws WitnessError('Malformed') for any field out of range. */
export function encodeWitnessBody(body: WitnessBody): Uint8Array {
  check(body)
  return concatBytes(
    Uint8Array.of(WITNESS_VERSION),
    body.paymentId,
    body.payerKey,
    body.receiverKey,
    body.challenge,
    u32(body.issuedAt),
    Uint8Array.of(body.channel),
  )
}

/** The 96-byte message the payer's device key signs. */
export const witnessEnvelope = (domain: Uint8Array, body: WitnessBody) =>
  envelope(domain, body.paymentId, content(encodeWitnessBody(body)))

export const encodeEvidence = (evidence: WitnessEvidence) =>
  concatBytes(encodeWitnessBody(evidence), evidence.signature)

export function decodeEvidence(wire: Uint8Array): WitnessEvidence {
  if (wire.length !== EVIDENCE_BYTES || wire[0] !== WITNESS_VERSION) throw new WitnessError('Malformed')
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
  const evidence: WitnessEvidence = {
    paymentId: wire.slice(1, 33),
    payerKey: wire.slice(33, 66),
    receiverKey: wire.slice(66, 99),
    challenge: wire.slice(99, 107),
    issuedAt: view.getUint32(107, true),
    channel: wire[111],
    signature: wire.slice(BODY_BYTES),
  }
  check(evidence)
  return evidence
}

export type ChallengeMessage = { challenge: Uint8Array; issuedAt: number }

const challengeTag = (paymentId: Uint8Array, { challenge, issuedAt }: ChallengeMessage) =>
  hmac(sha256, paymentId, concatBytes(TAG_LABEL, challenge, u32(issuedAt))).slice(0, TAG_BYTES)

export function encodeChallengeMessage(paymentId: Uint8Array, message: ChallengeMessage): Uint8Array {
  if (message.challenge.length !== CHALLENGE_BYTES || !isU32(message.issuedAt)) throw new WitnessError('Malformed')
  return concatBytes(
    Uint8Array.of(CHALLENGE_TYPE),
    message.challenge,
    u32(message.issuedAt),
    challengeTag(paymentId, message),
  )
}

/** Null: not a challenge, not for this payment, or a bad tag. */
export function decodeChallengeMessage(paymentId: Uint8Array, wire: Uint8Array): ChallengeMessage | null {
  if (wire.length !== CHALLENGE_MESSAGE_BYTES || wire[0] !== CHALLENGE_TYPE) return null
  const message = {
    challenge: wire.slice(1, 9),
    issuedAt: new DataView(wire.buffer, wire.byteOffset, wire.byteLength).getUint32(9, true),
  }
  const tag = challengeTag(paymentId, message)
  let diff = 0
  for (let i = 0; i < TAG_BYTES; i++) diff |= tag[i] ^ wire[13 + i]
  return diff === 0 ? message : null
}

export function encodeResponseMessage(signature: Uint8Array): Uint8Array {
  if (signature.length !== SIGNATURE_BYTES) throw new WitnessError('Malformed')
  return concatBytes(Uint8Array.of(RESPONSE_TYPE), signature)
}

export const decodeResponseMessage = (wire: Uint8Array): Uint8Array | null =>
  wire.length === RESPONSE_MESSAGE_BYTES && wire[0] === RESPONSE_TYPE ? wire.slice(1) : null

/** Throws WitnessError('Signature'). Says nothing about where either phone was. */
export function verifyWitness(witnessDomain: Uint8Array, evidence: WitnessEvidence): void {
  try {
    verifySignature(evidence.payerKey, witnessEnvelope(witnessDomain, evidence), evidence.signature)
  } catch (error) {
    throw error instanceof WitnessError ? error : new WitnessError('Signature')
  }
}
