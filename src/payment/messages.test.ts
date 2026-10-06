import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'
import { encodeFrames } from '../transport/framing'
import { frameToText } from '../transport/qr/text'
import { MessageKind } from '../transport/types'
import { QR_CHARS, qrFrameLimits } from '../transport/qr/limits'
import {
  decodeBundle,
  decodeReceipt,
  decodeRequest,
  encodeBundle,
  encodeReceipt,
  encodeRequest,
  MAX_MEMO_BYTES,
  PaymentError,
  paymentId,
  type PaymentRequest,
  safetyCode,
  sanitizeMemo,
} from './messages'
import { Reason, reasonOf } from './reasons'
import { ProtocolError, type ErrorCode, TicketRefusal } from '../protocol'
import { MINT, makeTicket, NOTE_DOMAIN, party, signIssue } from './testing/world'

const payer = party(1)
const receiver = party(2)

const request = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({
  owner: { type: 'device', key: receiver.key },
  mint: MINT,
  amount: 5_000_000n,
  now: 1_800_000_000,
  minWindow: 3600,
  minHops: 1,
  attesters: [7],
  memo: '',
  ...over,
})

const issue = (over = {}) => ({
  issuer: payer.key,
  mint: MINT,
  lockSeq: 3,
  cumEnd: 5_000_000n,
  salt: new Uint8Array(16).fill(9),
  owner: { type: 'device' as const, key: receiver.key },
  amount: 5_000_000n,
  caveats: { expiry: 1_800_100_000, hopsLeft: 3, flags: 0, scopeKind: 0, scope: new Uint8Array(20) },
  ...over,
})
const ticket = () =>
  makeTicket({
    device: payer.key,
    mint: MINT,
    lockSeq: 3,
    bond: 50_000_000n,
    backing: 50_000_000n,
    lockUntil: 1_900_000_000,
  })
const bundle = () => ({ issue: signIssue(payer, issue()), spends: [], tickets: [ticket()] })

describe('PaymentRequest', () => {
  it('round-trips and is 89 bytes with one attester and no memo, 136 with a 48-byte memo', () => {
    expect(decodeRequest(encodeRequest(request()))).toEqual(request())
    expect(encodeRequest(request())).toHaveLength(88)
    const memo = 'x'.repeat(MAX_MEMO_BYTES)
    expect(encodeRequest(request({ memo }))).toHaveLength(136)
    expect(decodeRequest(encodeRequest(request({ memo }))).memo).toBe(memo)
  })

  it('carries an account owner and several attesters', () => {
    const wanted = request({
      owner: { type: 'account', address: new Uint8Array(32).fill(4) },
      attesters: [1, 2, 65535],
    })
    expect(decodeRequest(encodeRequest(wanted))).toEqual(wanted)
  })

  it('fits one QR frame with room to spare (a request is version 8)', () => {
    const frames = encodeFrames(
      { kind: MessageKind.Request, payload: encodeRequest(request({ memo: 'x'.repeat(48) })) },
      qrFrameLimits(),
    )
    expect(frames).toHaveLength(1)
    expect(frameToText(frames[0]).length).toBeLessThanOrEqual(221)
  })

  it.each([
    ['another version', (w: Uint8Array) => ((w[0] = 2), w)],
    ['trailing bytes', (w: Uint8Array) => Uint8Array.from([...w, 0])],
    ['a truncated memo', (w: Uint8Array) => w.slice(0, -1)],
    ['unknown flag bits', (w: Uint8Array) => ((w[83] = 1), w)],
    ['no attester', (w: Uint8Array) => ((w[84] = 0), w)],
    ['an amount of zero', (w: Uint8Array) => (w.fill(0, 66, 74), w)],
    ['no hops', (w: Uint8Array) => ((w[82] = 0), w)],
    ['more than 16 hops', (w: Uint8Array) => ((w[82] = 17), w)],
    ['an owner type that is reserved', (w: Uint8Array) => ((w[1] = 1), w)],
  ])('refuses %s', (_, damage) => {
    const wire = damage(encodeRequest(request()).slice())
    expect(() => decodeRequest(wire)).toThrow()
  })

  it('refuses a memo that is not UTF-8 and one above 48 bytes', () => {
    const wire = encodeRequest(request({ memo: 'ab' })).slice()
    wire[wire.length - 1] = 0xff
    expect(() => decodeRequest(wire)).toThrow(PaymentError)
    expect(() => encodeRequest(request({ memo: 'x'.repeat(49) }))).toThrow(PaymentError)
  })
})

describe('Bundle', () => {
  it('is 391 bytes for a first payment and fits one QR frame', () => {
    const wire = encodeBundle(bundle())
    expect(wire).toHaveLength(3 + 227 + 161)
    const frames = encodeFrames({ kind: MessageKind.Payment, payload: wire }, qrFrameLimits())
    expect(frames).toHaveLength(1)
    expect(frameToText(frames[0]).length).toBeLessThanOrEqual(QR_CHARS.single)
  })

  it('round-trips byte for byte', () => {
    const wire = encodeBundle(bundle())
    expect(encodeBundle(decodeBundle(wire))).toEqual(wire)
  })

  it.each([
    ['trailing bytes', (w: Uint8Array) => Uint8Array.from([...w, 0])],
    ['a missing ticket', (w: Uint8Array) => w.slice(0, -1)],
    ['another version', (w: Uint8Array) => ((w[0] = 2), w)],
    ['more tickets than spends plus one', (w: Uint8Array) => ((w[2] = 2), w)],
    ['more than 16 spends', (w: Uint8Array) => ((w[1] = 17), w)],
    ['a spend count with no spends behind it', (w: Uint8Array) => ((w[1] = 1), w)],
  ])('refuses %s', (_, damage) => {
    expect(() => decodeBundle(damage(encodeBundle(bundle()).slice()))).toThrow()
  })

  it('names the payment by the message id of its issue when there are no spends', () => {
    const id = paymentId(NOTE_DOMAIN, bundle())
    expect(id).toHaveLength(32)
    expect(paymentId(NOTE_DOMAIN, bundle())).toEqual(id)
    expect(paymentId(NOTE_DOMAIN, { ...bundle(), issue: signIssue(payer, issue({ cumEnd: 6_000_000n })) })).not.toEqual(
      id,
    )
  })

  it('names the payment by the same id whatever its signature bytes', () => {
    const a = bundle()
    const b = { ...a, issue: { ...a.issue, signature: new Uint8Array(64).fill(1) } }
    expect(paymentId(NOTE_DOMAIN, b)).toEqual(paymentId(NOTE_DOMAIN, a))
  })
})

describe('Receipt', () => {
  const id = new Uint8Array(32).fill(5)

  it('is 35 bytes and round-trips', () => {
    expect(encodeReceipt({ accepted: true, reason: Reason.Accepted, messageId: id })).toHaveLength(35)
    for (const reason of Object.values(Reason)) {
      const receipt = { accepted: reason === Reason.Accepted, reason, messageId: id }
      expect(decodeReceipt(encodeReceipt(receipt))).toEqual(receipt)
    }
  })

  it.each([
    ['accepted with a reason', Uint8Array.of(1, 0, 3)],
    ['rejected with no reason', Uint8Array.of(1, 1, 0)],
    ['an unknown reason', Uint8Array.of(1, 1, 99)],
    ['an unknown status', Uint8Array.of(1, 2, 0)],
    ['another version', Uint8Array.of(2, 0, 0)],
  ])('refuses %s', (_, head) => {
    expect(() => decodeReceipt(Uint8Array.from([...head, ...id]))).toThrow(PaymentError)
  })

  it('refuses a wrong length', () => {
    expect(() => decodeReceipt(new Uint8Array(34))).toThrow(PaymentError)
  })
})

describe('reasons', () => {
  const codes: ErrorCode[] = [
    'Length',
    'Version',
    'Kind',
    'Owner',
    'Flags',
    'ScopeKind',
    'Scope',
    'Amount',
    'Depth',
    'Attenuation',
    'Linkage',
    'Signer',
    'Signature',
    'Expired',
    'Change',
    'Lock',
    'Ticket',
    'Window',
    'Payee',
  ]

  it('gives every protocol error a reason, and the ones a person can act on their own', () => {
    for (const code of codes) expect(reasonOf(new ProtocolError(code))).toBeGreaterThan(0)
    expect(reasonOf(new ProtocolError('Ticket'))).toBe(Reason.Ticket)
    expect(reasonOf(new ProtocolError('Window'))).toBe(Reason.Window)
    expect(reasonOf(new ProtocolError('Payee'))).toBe(Reason.NotForYou)
    expect(reasonOf(new ProtocolError('Signature'))).toBe(Reason.Signature)
    expect(reasonOf(new ProtocolError('Signer'))).toBe(Reason.Signature)
    expect(reasonOf(new ProtocolError('Expired'))).toBe(Reason.Expired)
    expect(reasonOf(new Error('boom'))).toBe(Reason.Unreadable)
  })

  it('maps the rules the repository added to a reason, and the cap on an attester to the limit', () => {
    expect(reasonOf(new ProtocolError('ExpiryStep'))).toBe(Reason.Invalid)
    expect(reasonOf(new ProtocolError('Unrecordable'))).toBe(Reason.Invalid)
    expect(reasonOf(new TicketRefusal('AttesterCap'))).toBe(Reason.OverLimit)
    for (const why of ['Stale', 'Bond', 'UnknownAttester', 'AttesterStake', 'Signature'] as const) {
      expect(reasonOf(new TicketRefusal(why))).toBe(Reason.Ticket)
    }
  })
})

describe('sanitizeMemo', () => {
  const at = (...codes: number[]) => String.fromCodePoint(...codes)
  it.each([
    ['plain text', 'Coffee x2', 'Coffee x2'],
    ['newlines and tabs', 'Pay $1\n\nTO: attacker', 'Pay $1 TO: attacker'],
    ['bidirectional overrides', `abc${at(0x202e)}def${at(0x2066)}`, 'abc def'],
    ['zero-width characters', `a${at(0x200b)}b${at(0x2060)}c${at(0xfeff)}d`, 'a b c d'],
    ['control characters', `a${at(0)}b${at(0x7f)}c${at(0x9f)}d`, 'a b c d'],
    ['line and paragraph separators', `a${at(0x2028)}b${at(0x2029)}c`, 'a b c'],
    ['runs of spaces', '  a    b  ', 'a b'],
    ['an empty memo', '', ''],
  ])('cleans %s', (_, input, expected) => {
    expect(sanitizeMemo(input)).toBe(expected)
  })
})

describe('safetyCode', () => {
  const keyOf = (seed: number) => p256.getPublicKey(sha256(Uint8Array.of(seed & 255, seed >> 8)), true)

  it('is eight characters in two groups, the same for the same key', () => {
    const code = safetyCode({ type: 'device', key: receiver.key })
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    expect(safetyCode({ type: 'device', key: receiver.key })).toBe(code)
  })

  it('differs between 300 keys', () => {
    const codes = new Set(Array.from({ length: 300 }, (_, seed) => safetyCode({ type: 'device', key: keyOf(seed) })))
    expect(codes.size).toBe(300)
  })

  it('depends on the owner type as well as the bytes', () => {
    const bytes = new Uint8Array(32).fill(3)
    expect(safetyCode({ type: 'account', address: bytes })).not.toBe(safetyCode({ type: 'device', key: receiver.key }))
  })
})
