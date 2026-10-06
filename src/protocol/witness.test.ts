import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { content, domain, envelope, verifySignature, verifySpendConflict } from './index'
import {
  BODY_BYTES,
  CHANNEL_AUDIBLE,
  CHANNEL_ULTRASOUND,
  decodeChallengeMessage,
  decodeEvidence,
  decodeResponseMessage,
  encodeChallengeMessage,
  encodeEvidence,
  encodeResponseMessage,
  encodeWitnessBody,
  EVIDENCE_BYTES,
  type WitnessBody,
  type WitnessEvidence,
  verifyWitness,
  witnessEnvelope,
  WitnessError,
} from './witness'
import { NOTE_DOMAIN, PAYMENT_ID, party, softSigner, WITNESS_DOMAIN } from './testing/witness'

const payer = party(1)
const shop = party(2)
const body = (over: Partial<WitnessBody> = {}): WitnessBody => ({
  paymentId: PAYMENT_ID,
  payerKey: payer.key,
  receiverKey: shop.key,
  challenge: Uint8Array.from({ length: 8 }, (_, i) => i + 1),
  issuedAt: 1_800_000_000,
  channel: CHANNEL_ULTRASOUND,
  ...over,
})

describe('witness body', () => {
  it('is 112 bytes laid out version, payment id, payer key, receiver key, challenge, issued at, channel', () => {
    const wire = encodeWitnessBody(body())
    expect(wire).toHaveLength(BODY_BYTES)
    expect(wire[0]).toBe(1)
    expect(wire.slice(1, 33)).toEqual(PAYMENT_ID)
    expect(wire.slice(33, 66)).toEqual(payer.key)
    expect(wire.slice(66, 99)).toEqual(shop.key)
    expect(wire.slice(99, 107)).toEqual(body().challenge)
    expect(new DataView(wire.buffer).getUint32(107, true)).toBe(1_800_000_000)
    expect(wire[111]).toBe(CHANNEL_ULTRASOUND)
  })

  it('accepts the audible channel as well as the ultrasound one', () => {
    expect(encodeWitnessBody(body({ channel: CHANNEL_AUDIBLE }))[111]).toBe(2)
  })

  it('refuses a field out of range', () => {
    for (const bad of [
      body({ paymentId: new Uint8Array(31) }),
      body({ payerKey: new Uint8Array(33).fill(4) }),
      body({ receiverKey: new Uint8Array(32) }),
      body({ challenge: new Uint8Array(7) }),
      body({ issuedAt: -1 }),
      body({ issuedAt: 2 ** 32 }),
      body({ issuedAt: 1.5 }),
      body({ channel: 0 }),
      body({ channel: 3 }),
    ]) {
      expect(() => encodeWitnessBody(bad)).toThrow(WitnessError)
    }
  })

  it('is signed as the 96-byte envelope of the witness domain, the payment id as slot and the body hash', () => {
    const message = witnessEnvelope(WITNESS_DOMAIN, body())
    expect(message).toHaveLength(96)
    expect(message).toEqual(envelope(WITNESS_DOMAIN, PAYMENT_ID, content(encodeWitnessBody(body()))))
    expect(content(encodeWitnessBody(body()))).toEqual(sha256(encodeWitnessBody(body())))
  })

  it('binds every field: changing any one changes the message', () => {
    const base = witnessEnvelope(WITNESS_DOMAIN, body())
    for (const changed of [
      body({ paymentId: new Uint8Array(32).fill(1) }),
      body({ payerKey: party(9).key }),
      body({ receiverKey: party(9).key }),
      body({ challenge: new Uint8Array(8).fill(9) }),
      body({ issuedAt: 1_800_000_001 }),
    ]) {
      expect(witnessEnvelope(WITNESS_DOMAIN, changed)).not.toEqual(base)
    }
  })

  it('never verifies as a note: another purpose, another domain', async () => {
    const signature = await softSigner(payer)(body())
    verifySignature(payer.key, witnessEnvelope(WITNESS_DOMAIN, body()), signature)
    expect(WITNESS_DOMAIN).not.toEqual(NOTE_DOMAIN)
    expect(() =>
      verifySignature(payer.key, envelope(NOTE_DOMAIN, PAYMENT_ID, content(encodeWitnessBody(body()))), signature),
    ).toThrow()
  })

  it('is signed low-S so it can be verified like every other signature', async () => {
    const signature = await softSigner(payer)(body())
    const s = BigInt(`0x${Buffer.from(signature.slice(32)).toString('hex')}`)
    expect(s <= p256.Point.Fn.ORDER / 2n).toBe(true)
  })
})

describe('evidence', () => {
  const evidence = async (): Promise<WitnessEvidence> => ({ ...body(), signature: await softSigner(payer)(body()) })

  it('is 176 bytes and round trips', async () => {
    const wire = encodeEvidence(await evidence())
    expect(wire).toHaveLength(EVIDENCE_BYTES)
    expect(decodeEvidence(wire)).toEqual(await evidence())
  })

  it('is refused when the length, the version, the channel or a key is wrong', async () => {
    const good = encodeEvidence(await evidence())
    const bad = (edit: (b: Uint8Array) => void) => {
      const copy = good.slice()
      edit(copy)
      return copy
    }
    for (const wire of [
      good.slice(0, 175),
      Uint8Array.from([...good, 0]),
      bad((b) => (b[0] = 2)),
      bad((b) => (b[111] = 9)),
      bad((b) => (b[33] = 0x05)),
      bad((b) => (b[66] = 0x00)),
    ]) {
      expect(() => decodeEvidence(wire)).toThrow(WitnessError)
    }
  })
})

describe('acoustic messages', () => {
  const challenge = { challenge: Uint8Array.from({ length: 8 }, (_, i) => 0xa0 + i), issuedAt: 1_800_000_000 }

  it('a challenge is 17 bytes and decodes for the payment it was made for', () => {
    const wire = encodeChallengeMessage(PAYMENT_ID, challenge)
    expect(wire).toHaveLength(17)
    expect(decodeChallengeMessage(PAYMENT_ID, wire)).toEqual(challenge)
  })

  it('a challenge does not decode for another payment or with a damaged byte', () => {
    const wire = encodeChallengeMessage(PAYMENT_ID, challenge)
    expect(decodeChallengeMessage(new Uint8Array(32).fill(1), wire)).toBeNull()
    for (let i = 0; i < wire.length; i++) {
      const copy = wire.slice()
      copy[i] ^= 0x01
      expect(decodeChallengeMessage(PAYMENT_ID, copy)).toBeNull()
    }
    expect(decodeChallengeMessage(PAYMENT_ID, wire.slice(0, 16))).toBeNull()
  })

  it('a response is 65 bytes and only a response decodes as one', () => {
    const signature = new Uint8Array(64).fill(3)
    const wire = encodeResponseMessage(signature)
    expect(wire).toHaveLength(65)
    expect(decodeResponseMessage(wire)).toEqual(signature)
    expect(decodeResponseMessage(encodeChallengeMessage(PAYMENT_ID, challenge))).toBeNull()
    expect(decodeResponseMessage(wire.slice(0, 64))).toBeNull()
    expect(decodeResponseMessage(Uint8Array.from([0x13, ...signature]))).toBeNull()
  })

  it('the domain of the witness is not the domain of any other purpose', () => {
    const genesis = new Uint8Array(32).fill(1)
    const program = new Uint8Array(32).fill(2)
    expect(domain('witness', genesis, program)).not.toEqual(domain('note', genesis, program))
  })
})

describe('known answers', () => {
  const challenge = Uint8Array.from({ length: 8 }, (_, i) => 0xa0 + i)

  it('encodes the body, hashes it and builds the envelope the same way for ever', () => {
    const wire = encodeWitnessBody(body())
    expect(bytesToHex(wire)).toBe(
      '017777777777777777777777777777777777777777777777777777777777777777026ff03b949241ce1dadd43519e6960e0a85b41a69a05c328103aa2bce1594ca1602550f471003f3df97c3df506ac797f6721fb1a1fb7b8f6f83d224498a65c88e24010203040506070800d2496b01',
    )
    expect(bytesToHex(content(wire))).toBe('cc9ad5f26ac1dcf1f1d6ec3ab78447c012550844d33f0f4e1eddc392f750bc03')
    expect(bytesToHex(witnessEnvelope(WITNESS_DOMAIN, body()))).toBe(
      '383e0eb3d01d2370562858e704d354d7a2be478490f5936dfc0b51a2f577d3227777777777777777777777777777777777777777777777777777777777777777cc9ad5f26ac1dcf1f1d6ec3ab78447c012550844d33f0f4e1eddc392f750bc03',
    )
  })

  it('encodes a challenge for the payment the same way for ever', () => {
    expect(bytesToHex(encodeChallengeMessage(PAYMENT_ID, { challenge, issuedAt: 1_800_000_000 }))).toBe(
      '11a0a1a2a3a4a5a6a700d2496bc5154f99',
    )
  })
})

const fixed: WitnessBody = {
  paymentId: PAYMENT_ID,
  payerKey: payer.key,
  receiverKey: shop.key,
  challenge: new Uint8Array(8).fill(5),
  issuedAt: 1_800_000_000,
  channel: CHANNEL_ULTRASOUND,
}
const signedBy = async (who = payer, what = fixed): Promise<WitnessEvidence> => ({
  ...what,
  signature: await softSigner(who)(what),
})

describe('domain separation', () => {
  it('a witness signature cannot be the second half of a double-spend proof', async () => {
    const slot = PAYMENT_ID
    const contentA = new Uint8Array(32).fill(1)
    const signatureA = p256.sign(envelope(NOTE_DOMAIN, slot, contentA), payer.secret, {
      prehash: true,
      lowS: true,
      format: 'compact',
    })
    const signatureB = await softSigner(payer)(body())
    const conflict = {
      slot,
      contentA,
      signatureA,
      contentB: content(encodeWitnessBody(body())),
      signatureB,
      recovery: 0,
    }
    expect(() => verifySpendConflict(NOTE_DOMAIN, payer.key, conflict)).toThrow()
  })

  it('a note signature is not a witness', async () => {
    const note = p256.sign(envelope(NOTE_DOMAIN, PAYMENT_ID, content(encodeWitnessBody(body()))), payer.secret, {
      prehash: true,
      lowS: true,
      format: 'compact',
    })
    expect(() => verifyWitness(WITNESS_DOMAIN, { ...body(), signature: note })).toThrow(WitnessError)
  })
})

describe('verifyWitness', () => {
  it('accepts a statement signed by the payer key', async () => {
    const evidence = await signedBy()
    expect(() => verifyWitness(WITNESS_DOMAIN, evidence)).not.toThrow()
  })

  it('refuses a statement signed by another key, including the receiver', async () => {
    for (const who of [party(9), shop]) {
      const forged = await signedBy(who)
      expect(() => verifyWitness(WITNESS_DOMAIN, forged)).toThrow(WitnessError)
    }
  })

  it('refuses every field changed after signing', async () => {
    const evidence = await signedBy()
    for (const changed of [
      { paymentId: new Uint8Array(32).fill(1) },
      { receiverKey: party(9).key },
      { challenge: new Uint8Array(8).fill(6) },
      { issuedAt: fixed.issuedAt + 1 },
    ]) {
      expect(() => verifyWitness(WITNESS_DOMAIN, { ...evidence, ...changed })).toThrow(WitnessError)
    }
  })

  it('refuses a signature made under another domain (another cluster or program)', async () => {
    const other = new Uint8Array(32).fill(9)
    const evidence = await signedBy()
    expect(() => verifyWitness(other, evidence)).toThrow(WitnessError)
  })

  it('refuses a high-S signature, so a malleated copy is not a second statement', async () => {
    const evidence = await signedBy()
    const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
    const s = BigInt(`0x${Buffer.from(evidence.signature.slice(32)).toString('hex')}`)
    const high = new Uint8Array(64)
    high.set(evidence.signature.slice(0, 32))
    high.set(Uint8Array.from(Buffer.from((n - s).toString(16).padStart(64, '0'), 'hex')), 32)
    expect(() => verifyWitness(WITNESS_DOMAIN, { ...evidence, signature: high })).toThrow(WitnessError)
  })
})
