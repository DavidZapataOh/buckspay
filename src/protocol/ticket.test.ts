import { ed25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js'
import { describe, expect, it } from 'vitest'

import { registryEntry } from '../test-support/registry'

import vectors from '../../anchor/crates/protocol/tests/vectors/v1.json'
import parity from '../../anchor/crates/protocol/tests/vectors/ed25519_parity.json'
import {
  accept,
  applyRevocation,
  type Attester,
  attesterFresh,
  decodeBondTicket,
  decodeIssue,
  decodeRevocation,
  encodeRevocation,
  MAX_NOTE_LIFE,
  MAX_REGISTRY_AGE,
  paymentLimit,
  reliedOn,
  releaseOn,
  revocationMessage,
  signingKeys,
  type TicketReason,
  TICKET_TTL_MAX,
  verifyEd25519,
} from '.'

const [vector] = vectors.payments
const ticketDomain = hexToBytes(vectors.domain.ticket)
const revokeDomain = hexToBytes(vectors.revocations.domain)
const [first] = vector.tickets.map((wire) => decodeBondTicket(hexToBytes(wire)))
const attester = registryEntry(vectors.registry[0])
const need = {
  mint: first.mint,
  amount: 20_000n,
  backing: 20_000n,
  expiry: decodeIssue(hexToBytes(vector.issue)).message.caveats.expiry,
}
const now = vector.now
const run = (entry: Attester, amount = need.amount) =>
  accept(now, ticketDomain, [entry], [first], { type: 'device', key: first.device }, first.lockSeq, {
    ...need,
    amount,
  })
const reason = (fn: () => unknown): TicketReason | undefined => {
  try {
    fn()
  } catch (error) {
    return (error as { reason?: TicketReason }).reason
  }
  return undefined
}

describe('ticket acceptance', () => {
  it('accepts a covering, fresh ticket from a trusted attester and names the attester', () => {
    expect(run(attester)).toEqual({ device: first.device, lockSeq: first.lockSeq, bond: first.bond, attester: 1 })
  })

  it('refuses each ground with its own reason', () => {
    const cases: [TicketReason, Attester][] = [
      ['Inactive', { ...attester, active: false }],
      ['RegistryStale', { ...attester, syncedAt: now - MAX_REGISTRY_AGE - 1 }],
      ['AttesterMint', { ...attester, mint: new Uint8Array(32).fill(4) }],
      ['AttesterStake', { ...attester, stake: 79_999n }],
      ['AttesterCap', { ...attester, relied: paymentLimit(attester.stake) - 19_999n }],
      ['UnknownKey', { ...attester, revoked: [attester.key, new Uint8Array(32)] }],
      ['Signature', { ...attester, key: registryEntry(vectors.registry[1]).key }],
    ]
    for (const [expected, entry] of cases)
      expect(
        reason(() => run(entry)),
        expected,
      ).toBe(expected)
  })

  it('keeps the cap exact and an amount above it alone a stake refusal', () => {
    const limit = paymentLimit(attester.stake)
    expect(run({ ...attester, relied: limit - 20_000n }).attester).toBe(1)
    expect(reason(() => run({ ...attester, relied: limit - 19_999n }))).toBe('AttesterCap')
    expect(reason(() => run({ ...attester, relied: 2n ** 64n - 1n }))).toBe('AttesterCap')
    const small = { ...attester, stake: 400_000n }
    expect(run(small, paymentLimit(small.stake)).attester).toBe(1)
    expect(reason(() => run(small, paymentLimit(small.stake) + 1n))).toBe('AttesterStake')
  })

  it('stops a thousand phantom payments of a quarter of the stake at the first', () => {
    const quarter = paymentLimit(attester.stake)
    let entry = attester
    let accepted = 0
    for (let i = 0; i < 1_000; i++) {
      const refusal = reason(() => run(entry, quarter))
      if (refusal === undefined) {
        entry = reliedOn(entry, quarter)
        accepted++
      } else {
        expect(refusal).toBe('AttesterCap')
      }
    }
    expect(accepted).toBe(1)
    expect(entry.relied).toBe(quarter)
  })

  it('never lets a wallet rely on one attester for more than a quarter of its stake in all', () => {
    let seed = 12345
    const next = (bound: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
      return seed % bound
    }
    for (let round = 0; round < 200; round++) {
      let entry: Attester = { ...attester, stake: BigInt(next(400_000)) }
      for (let step = 0; step < 30; step++) {
        const amount = BigInt(1 + next(60_000))
        if (reason(() => run(entry, amount)) === undefined) entry = reliedOn(entry, amount)
        expect(entry.relied <= paymentLimit(entry.stake)).toBe(true)
      }
    }
  })

  it('relies and releases without wrapping', () => {
    const max = 2n ** 64n - 1n
    expect(reliedOn(reliedOn(attester, max), 5n).relied).toBe(max)
    expect(releaseOn(releaseOn(reliedOn(attester, 9n), 9n), 7n).relied).toBe(0n)
  })

  it('believes a previous key only during its overlap and never a revoked or zero key', () => {
    const rotated = { ...attester, key: registryEntry(vectors.registry[1]).key, prevKey: attester.key }
    expect(signingKeys({ ...rotated, prevTrustedUntil: now + 1 }, now).filter(Boolean)).toHaveLength(2)
    expect(signingKeys({ ...rotated, prevTrustedUntil: now }, now).filter(Boolean)).toHaveLength(1)
    expect(signingKeys({ ...rotated, prevTrustedUntil: 0 }, now).filter(Boolean)).toHaveLength(1)
    const revoked = {
      ...rotated,
      prevTrustedUntil: now + 1,
      revoked: [attester.key, new Uint8Array(32)] as Attester['revoked'],
    }
    expect(signingKeys(revoked, now)[1]).toBeUndefined()
    expect(signingKeys({ ...attester, key: new Uint8Array(32) }, now)[0]).toBeUndefined()
  })

  it('believes a registry entry for at most the registry age', () => {
    expect(attesterFresh({ ...attester, syncedAt: now - MAX_REGISTRY_AGE }, now)).toBe(true)
    expect(attesterFresh({ ...attester, syncedAt: now - MAX_REGISTRY_AGE - 1 }, now)).toBe(false)
    expect(attesterFresh({ ...attester, syncedAt: now + 5 }, now)).toBe(true)
  })

  it('keeps a note shorter than the attester exit delay covers', () => {
    expect(MAX_NOTE_LIFE).toBe(TICKET_TTL_MAX)
  })
})

describe('revocations', () => {
  it('commits the same domain as Rust', () => {
    expect(bytesToHex(revokeDomain)).toBe(vectors.domain.revoke)
  })

  for (const vectorCase of vectors.revocations.cases) {
    it(`${vectorCase.name} has the same effect as in Rust`, () => {
      const wire = hexToBytes(vectorCase.wire)
      const revocation = decodeRevocation(wire)
      expect(bytesToHex(encodeRevocation(revocation))).toBe(vectorCase.wire)
      expect(bytesToHex(revocationMessage(revokeDomain, revocation))).toBe(vectorCase.signed_message)
      if (vectorCase.error === null) {
        const after = applyRevocation(attester, revokeDomain, revocation)
        expect(after.revoked.map(bytesToHex)).toEqual(vectorCase.revoked)
        expect(applyRevocation(after, revokeDomain, revocation).revoked.map(bytesToHex)).toEqual(vectorCase.revoked)
      } else {
        expect(() => applyRevocation(attester, revokeDomain, revocation)).toThrow(
          expect.objectContaining({ name: 'ProtocolError', code: vectorCase.error }),
        )
      }
    })
  }

  it('refuses lengths other than 100 bytes', () => {
    const wire = hexToBytes(vectors.revocations.cases[0].wire)
    for (const length of [0, 35, 99, 101]) {
      const resized = new Uint8Array(length)
      resized.set(wire.subarray(0, Math.min(length, wire.length)))
      expect(() => decodeRevocation(resized)).toThrow(expect.objectContaining({ code: 'Length' }))
    }
  })
})

describe('the Ed25519 verdicts the program and the receivers share', () => {
  for (const vectorCase of parity) {
    it(`${vectorCase.name} is ${vectorCase.verify_strict ? 'accepted' : 'refused'} like verify_strict`, () => {
      const key = hexToBytes(vectorCase.key)
      const message = hexToBytes(vectorCase.message)
      const signature = hexToBytes(vectorCase.signature)
      const strict = ed25519.verify(signature, message, key, { zip215: false })
      expect(strict).toBe(vectorCase.verify_strict)
      // The key and the nonce must be prime order too: that is the only difference the check adds.
      const mixed = vectorCase.name === 'mixed_order_key_challenge_multiple_of_8'
      expect(verifyEd25519(key, message, signature)).toBe(vectorCase.verify_strict && !mixed)
    })
  }
})
