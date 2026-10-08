import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex as hex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import vectors from '../../anchor/crates/protocol/tests/vectors/v1.json'
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH } from './cluster'
import { Kind, ProtocolError } from './codec'
import { content, domain, envelope, Purpose } from './hash'
import {
  checkFollows,
  checkIou,
  type CoSignedIou,
  decodeCoSigned,
  decodeIou,
  decodeJoin,
  encodeCoSigned,
  encodeIou,
  encodeJoin,
  type Iou,
  IOU_BODY_LEN,
  IOU_WIRE_LEN,
  IouCause,
  iouEnvelope,
  iouSlot,
  JOIN_BODY_LEN,
  joinSlot,
  verifyCoSigned,
  verifyJoin,
} from './iou'
import { decodeStatement } from './netting'

const PROGRAM = new Uint8Array(32).fill(0xb0)
const iouDomain = domain(Purpose.Iou, DEVNET_GENESIS_HASH, PROGRAM)
const mainnetIou = domain(Purpose.Iou, MAINNET_GENESIS_HASH, PROGRAM)
const v = vectors.iou

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof ProtocolError ? error.code : `not a ProtocolError: ${String(error)}`
  }
}

const secret = (seed: number) => new Uint8Array(32).fill(seed)
const keyOf = (seed: number) => p256.getPublicKey(secret(seed), true)
const signRaw = (seed: number, message: Uint8Array) =>
  p256.sign(message, secret(seed), { prehash: true, lowS: true, format: 'compact' })
const bytes32 = (fill: number) => new Uint8Array(32).fill(fill)

const state = (seq: number, debtor = 0xd1, creditor = 0xc1, amount = 10n): Iou => ({
  tab: bytes32(0x7a),
  seq,
  debtor: keyOf(debtor),
  creditor: keyOf(creditor),
  mint: bytes32(3),
  amount,
  due: 0,
  cause: IouCause.Open,
  reference: new Uint8Array(32),
  memo: new Uint8Array(32),
})

const coSign = (iou: Iou, under = iouDomain, debtor = 0xd1, creditor = 0xc1): CoSignedIou => {
  const message = iouEnvelope(iou, under)
  return { iou, debtorSig: signRaw(debtor, message), creditorSig: signRaw(creditor, message) }
}

describe('iou', () => {
  it('has the kinds and purpose of the protocol', () => {
    expect([Kind.Iou, Kind.NettingJoin, Kind.Netting]).toEqual([0x30, 0x31, 0x32])
    expect(Purpose.Netting).toBe('netting')
    expect([IOU_BODY_LEN, IOU_WIRE_LEN, JOIN_BODY_LEN]).toEqual([213, 341, 99])
  })

  it('matches every Rust state byte for byte', () => {
    expect(hex(iouDomain)).toBe(v.domain.devnet)
    expect(hex(mainnetIou)).toBe(v.domain.mainnet)
    expect(v.states.length).toBeGreaterThanOrEqual(4)
    for (const s of v.states) {
      const body = hexToBytes(s.body)
      const iou = decodeIou(body)
      expect(hex(encodeIou(iou)), s.name).toBe(s.body)
      expect(hex(iouSlot(iou.tab, iou.seq)), s.name).toBe(s.slot)
      expect(hex(content(body))).toBe(s.content)
      expect(hex(iouEnvelope(iou, iouDomain))).toBe(s.envelope.devnet)
      expect(hex(iouEnvelope(iou, mainnetIou))).toBe(s.envelope.mainnet)
      const signed = decodeCoSigned(hexToBytes(s.wire))
      expect(hex(encodeCoSigned(signed))).toBe(s.wire)
      expect(hex(signed.debtorSig)).toBe(s.debtor_sig)
      expect(hex(signed.creditorSig)).toBe(s.creditor_sig)
      expect(verifyCoSigned(signed, iouDomain), s.name).toBe(true)
      expect(verifyCoSigned(signed, mainnetIou), s.name).toBe(false)
    }
  })

  it('names each predecessor like Rust, and carries two alternatives on one predecessor', () => {
    const ious = v.states.map((s) => decodeIou(hexToBytes(s.body)))
    expect(hex(ious[0].reference)).toBe('00'.repeat(32))
    ious.slice(1).forEach((iou, i) => {
      if (iou.cause !== IouCause.Repay)
        expect(hex(iou.reference), `seq ${iou.seq}`).toBe(hex(content(encodeIou(ious[i]))))
    })
    const { predecessor, states, counted_seq } = v.alternatives
    expect(predecessor).toBe(hex(content(encodeIou(ious[ious.length - 1]))))
    const pair = states.map((w) => decodeCoSigned(hexToBytes(w)))
    expect(pair.map((p) => hex(p.iou.reference))).toEqual([predecessor, predecessor])
    for (const p of pair) expect(verifyCoSigned(p, iouDomain)).toBe(true)
    expect(counted_seq).toBe(Math.max(...pair.map((p) => p.iou.seq)))
  })

  it('signs like Rust: the fixed keys reproduce the vector signatures', () => {
    expect(hex(keyOf(0xd1))).toBe(v.keys.debtor)
    expect(hex(keyOf(0xc1))).toBe(v.keys.creditor)
    const seedOf = (key: Uint8Array) => (hex(key) === v.keys.debtor ? 0xd1 : 0xc1)
    for (const s of v.states) {
      const iou = decodeIou(hexToBytes(s.body))
      const message = iouEnvelope(iou, iouDomain)
      expect(hex(signRaw(seedOf(iou.debtor), message)), s.name).toBe(s.debtor_sig)
      expect(hex(signRaw(seedOf(iou.creditor), message)), s.name).toBe(s.creditor_sig)
    }
  })

  it('derives the slot from the tab and seq only', () => {
    const first = state(1)
    const seqLe = new Uint8Array(4)
    new DataView(seqLe.buffer).setUint32(0, 1, true)
    expect(hex(iouSlot(first.tab, 1))).toBe(hex(sha256(concatBytes(utf8ToBytes('IOUS'), first.tab, seqLe))))
    expect(hex(iouSlot(first.tab, 2))).not.toBe(hex(iouSlot(first.tab, 1)))
    expect(hex(iouEnvelope({ ...first, amount: 11n }, iouDomain).subarray(32, 64))).toBe(
      hex(iouEnvelope(first, iouDomain).subarray(32, 64)),
    )
  })

  it('refuses every invalid vector with its code', () => {
    const run = (c: (typeof vectors.nettingInvalid)[number]) => {
      const body = hexToBytes(c.body)
      switch (c.type) {
        case 'iou':
          return () => decodeIou(body)
        case 'cosigned':
          return () => decodeCoSigned(body)
        case 'follows':
          return () => checkFollows(decodeIou(body), decodeIou(hexToBytes((c as { previous: string }).previous)))
        case 'join':
          return () => decodeJoin(body)
        case 'statement':
          return () => decodeStatement(body)
        default:
          throw new Error(`unknown case type ${c.type}`)
      }
    }
    expect(vectors.nettingInvalid.length).toBeGreaterThanOrEqual(24)
    for (const c of vectors.nettingInvalid) expect(codeOf(run(c)), c.name).toBe(c.error)
  })

  it('checkIou refuses each rule with the Rust code', () => {
    const ok = state(1, 0xd1, 0xc1, 1n)
    expect(codeOf(() => checkIou(ok))).toBeUndefined()
    expect(codeOf(() => checkIou({ ...ok, cause: IouCause.Repay, reference: bytes32(9) }))).toBeUndefined()
    // an Open or Outside reference names a predecessor and is free
    expect(codeOf(() => checkIou({ ...ok, reference: bytes32(1) }))).toBeUndefined()
    expect(codeOf(() => checkIou({ ...ok, cause: IouCause.Outside, reference: bytes32(1) }))).toBeUndefined()
    const withCause = (cause: number, reference = ok.reference): Iou => ({
      ...ok,
      cause: cause as Iou['cause'],
      reference,
    })
    const uncompressed = Uint8Array.of(0x04, ...keyOf(0xd1).subarray(1))
    const cases: [string, Iou, string][] = [
      ['seq 0', { ...ok, seq: 0 }, 'Linkage'],
      ['same parties', { ...ok, creditor: ok.debtor }, 'Owner'],
      ['bad prefix', { ...ok, debtor: uncompressed }, 'Owner'],
      ['cause 0', withCause(0), 'Kind'],
      ['cause 5', withCause(5), 'Kind'],
      ['netting cause, reserved', withCause(IouCause.Netting, bytes32(0x4e)), 'Kind'],
      ['amount 0', { ...ok, amount: 0n }, 'Amount'],
      ['outside of 0', { ...ok, cause: IouCause.Outside, amount: 0n }, 'Amount'],
      ['repay without reference', { ...ok, cause: IouCause.Repay }, 'Kind'],
      ['short tab', { ...ok, tab: new Uint8Array(31) }, 'Length'],
      ['amount above u64', { ...ok, amount: 2n ** 64n }, 'Length'],
    ]
    for (const [name, iou, code] of cases) {
      expect(
        codeOf(() => checkIou(iou)),
        name,
      ).toBe(code)
      expect(
        codeOf(() => encodeIou(iou)),
        name,
      ).toBe(code)
    }
  })

  it('checkFollows accepts gaps and refuses non-increasing', () => {
    expect(codeOf(() => checkFollows(state(1), null))).toBeUndefined()
    expect(codeOf(() => checkFollows(state(9), state(1)))).toBeUndefined()
    expect(codeOf(() => checkFollows(state(10, 0xc1, 0xd1), state(9)))).toBeUndefined()
    const previous = state(5)
    const cases: [string, Iou][] = [
      ['same seq', state(5)],
      ['lower seq', state(4)],
      ['other tab', { ...state(6), tab: bytes32(0x7b) }],
      ['other mint', { ...state(6), mint: bytes32(4) }],
      ['third party as creditor', state(6, 0xd1, 0xe1)],
      ['third party as debtor', state(6, 0xe1, 0xc1)],
    ]
    for (const [name, next] of cases)
      expect(
        codeOf(() => checkFollows(next, previous)),
        name,
      ).toBe('Linkage')
  })

  it('verifyCoSigned refuses one-sided states', () => {
    const signed = coSign(state(2))
    expect(verifyCoSigned(signed, iouDomain)).toBe(true)
    const message = iouEnvelope(signed.iou, iouDomain)
    const cases: [string, CoSignedIou][] = [
      ['debtor twice', { ...signed, creditorSig: signed.debtorSig }],
      ['creditor twice', { ...signed, debtorSig: signed.creditorSig }],
      ['swapped', { ...signed, debtorSig: signed.creditorSig, creditorSig: signed.debtorSig }],
      ['no creditor signature', { ...signed, creditorSig: new Uint8Array(64) }],
      ['a third key', { ...signed, creditorSig: signRaw(0xe1, message) }],
      ['another body', { ...signed, iou: { ...signed.iou, amount: 11n } }],
      [
        'malformed key',
        { ...signed, iou: { ...signed.iou, debtor: Uint8Array.of(0x04, ...signed.iou.debtor.subarray(1)) } },
      ],
    ]
    for (const [name, s] of cases) expect(verifyCoSigned(s, iouDomain), name).toBe(false)
  })

  it('verifyCoSigned refuses a state signed under the note domain', () => {
    const iou = state(1)
    for (const purpose of [Purpose.Note, Purpose.PayWord, Purpose.Netting, Purpose.Witness] as const) {
      const other = domain(purpose, DEVNET_GENESIS_HASH, PROGRAM)
      expect(verifyCoSigned(coSign(iou, other), iouDomain), purpose).toBe(false)
      expect(verifyCoSigned(coSign(iou), other), purpose).toBe(false)
    }
    const asNote = envelope(
      domain(Purpose.Note, DEVNET_GENESIS_HASH, PROGRAM),
      iouSlot(iou.tab, iou.seq),
      content(encodeIou(iou)),
    )
    const signed = coSign(iou)
    expect(p256.verify(signed.debtorSig, asNote, keyOf(0xd1), { prehash: true, lowS: true, format: 'compact' })).toBe(
      false,
    )
  })

  it('decodeCoSigned refuses any other length', () => {
    const wire = encodeCoSigned(coSign(state(3)))
    expect(wire.length).toBe(IOU_WIRE_LEN)
    expect(codeOf(() => decodeCoSigned(wire.subarray(0, 340)))).toBe('Length')
    expect(codeOf(() => decodeCoSigned(concatBytes(wire, Uint8Array.of(0))))).toBe('Length')
  })

  it('iou and join slots never coincide, and a session has one join slot', () => {
    const session = bytes32(0x5e)
    expect(hex(joinSlot(session))).toBe(hex(sha256(concatBytes(utf8ToBytes('NETJ'), session))))
    expect(hex(joinSlot(session))).not.toBe(hex(iouSlot(session, 1)))
    expect(hex(joinSlot(session))).not.toBe(hex(joinSlot(bytes32(0x5f))))
  })

  it('matches the Rust joins and verifies them under the iou domain only', () => {
    const noteDomain = domain(Purpose.Note, DEVNET_GENESIS_HASH, PROGRAM)
    for (const j of vectors.nettingJoin.joins) {
      const body = hexToBytes(j.body)
      const join = decodeJoin(body)
      expect(hex(encodeJoin(join))).toBe(j.body)
      expect(hex(joinSlot(join.session))).toBe(j.slot)
      expect(hex(envelope(iouDomain, joinSlot(join.session), content(body)))).toBe(j.envelope)
      expect(verifyJoin(body, hexToBytes(j.signature), iouDomain), j.name).toBe(true)
      expect(verifyJoin(body, hexToBytes(j.signature), noteDomain), j.name).toBe(false)
      const other = encodeJoin({ ...join, ephemeral: bytes32(9) })
      expect(verifyJoin(other, hexToBytes(j.signature), iouDomain)).toBe(false)
    }
  })

  it('small_order_ephemeral_refused_by_verifyJoin', () => {
    // A join correctly signed by its device key still fails when its ephemeral Ed25519 key is not of prime order (L2).
    const identity = Uint8Array.of(1, ...new Uint8Array(31))
    const torsion = hexToBytes('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a')
    for (const ephemeral of [identity, torsion, new Uint8Array(32)]) {
      const body = encodeJoin({ session: bytes32(0x5e), ephemeral, key: keyOf(0xd1) })
      const signature = signRaw(0xd1, envelope(iouDomain, joinSlot(bytes32(0x5e)), content(body)))
      expect(verifyJoin(body, signature, iouDomain), hex(ephemeral)).toBe(false)
    }
    const good = encodeJoin({
      session: bytes32(0x5e),
      ephemeral: decodeJoin(hexToBytes(vectors.nettingJoin.joins[0].body)).ephemeral,
      key: keyOf(0xd1),
    })
    expect(
      verifyJoin(good, signRaw(0xd1, envelope(iouDomain, joinSlot(bytes32(0x5e)), content(good))), iouDomain),
    ).toBe(true)
  })
})
