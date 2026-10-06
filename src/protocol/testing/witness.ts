import { p256 } from '@noble/curves/nist.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import vectors from '../../../anchor/crates/protocol/tests/vectors/v1.json'
import { type WitnessBody, witnessEnvelope } from '../witness'

export const WITNESS_DOMAIN = hexToBytes(vectors.domain.witness)
export const NOTE_DOMAIN = hexToBytes(vectors.domain.note)

export type Party = { secret: Uint8Array; key: Uint8Array }
export function party(seed: number): Party {
  const secret = new Uint8Array(32).fill(seed)
  return { secret, key: p256.getPublicKey(secret, true) }
}

/** Software P-256, low-S, over the witness envelope: what `signWitnessRecord` returns from the native module. */
export const softSigner = (who: Party) => async (body: WitnessBody) =>
  p256.sign(witnessEnvelope(WITNESS_DOMAIN, body), who.secret, { prehash: true, lowS: true, format: 'compact' })

export const PAYMENT_ID = new Uint8Array(32).fill(0x77)
