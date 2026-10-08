import { describe, expect, it } from 'vitest'
import { content, encodeIou, iouEnvelope, ProtocolError } from '../../protocol'
import { createLoopbackPair } from '../../transport/testing/loopback'
import { MessageKind, TransportError } from '../../transport/types'
import {
  DebtMessageType,
  DeclineReason,
  decodeDebtMessage,
  encodeDebtMessage,
  OfferFlags,
  offerChange,
  type TabOffer,
} from './exchange'
import { memoHash } from './tab'
import { coSigned, IOU_DOMAIN, iouOf, party, SECRET } from './testing'

const [ana, ben] = [party(0xa1), party(0xb1)]
const FINAL = new Uint8Array(32).fill(0xfc)
const state = iouOf(1, ben.key, ana.key, 25_000_000n, { memo: memoHash('Café') })
const body = encodeIou(state)
const offer: TabOffer = {
  body,
  signature: ana.sign(iouEnvelope(state, IOU_DOMAIN)),
  finalContent: FINAL,
  secret: SECRET,
  memo: 'Café',
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const codeOf = (run: () => unknown) => {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof ProtocolError ? error.code : String(error)
  }
}
const debts = (payload: Uint8Array) => ({ kind: MessageKind.Debts, payload })

describe('debt messages', () => {
  it('every debt message round-trips with the layout of the spec', () => {
    const m = encodeDebtMessage({ type: DebtMessageType.TabOffer, offer })
    expect(m.kind).toBe(MessageKind.Debts)
    const p = m.payload
    expect(p[0]).toBe(0x01)
    expect(p.subarray(1, 214)).toEqual(body)
    expect(p.subarray(214, 278)).toEqual(offer.signature)
    expect(p.subarray(278, 310)).toEqual(FINAL)
    expect(p[310]).toBe(OfferFlags.First)
    expect(p.subarray(311, 343)).toEqual(SECRET)
    expect(p[343]).toBe(5)
    expect(p.length).toBe(349)
    expect(decodeDebtMessage(m)).toEqual({ type: 0x01, offer })
    const later: TabOffer = { ...offer, secret: null, memo: null }
    const m2 = encodeDebtMessage({ type: 0x01, offer: later })
    expect(m2.payload.length).toBe(312)
    expect(decodeDebtMessage(m2)).toEqual({ type: 0x01, offer: later })
    const accept = { type: 0x02, content: content(body), signature: ben.sign(iouEnvelope(state, IOU_DOMAIN)) } as const
    expect(encodeDebtMessage(accept).payload.length).toBe(97)
    expect(decodeDebtMessage(encodeDebtMessage(accept))).toEqual(accept)
    for (const reason of [DeclineReason.Stale, DeclineReason.Behind]) {
      const decline = { type: 0x03, content: content(body), reason } as const
      expect(encodeDebtMessage(decline).payload.length).toBe(34)
      expect(decodeDebtMessage(encodeDebtMessage(decline))).toEqual(decline)
    }
    const states = [coSigned(state, ben, ana), coSigned(iouOf(2, ben.key, ana.key, 1n), ben, ana)]
    const tabStates = encodeDebtMessage({ type: DebtMessageType.TabStates, states })
    expect(tabStates.payload.length).toBe(2 + 2 * 341)
    expect(tabStates.payload[1]).toBe(2)
    expect(decodeDebtMessage(tabStates)).toEqual({ type: 0x04, states })
  })

  it('refuses truncation, unknown flags, long memos, foreign kinds and the group types', () => {
    const full = encodeDebtMessage({ type: 0x01, offer }).payload
    for (const cut of [0, 1, 213, 278, 309, 310, 330, 343, full.length - 1])
      expect(
        codeOf(() => decodeDebtMessage(debts(full.subarray(0, cut)))),
        `cut ${cut}`,
      ).toBe('Length')
    expect(codeOf(() => decodeDebtMessage(debts(Uint8Array.of(...full, 0))))).toBe('Length')
    const flags = full.slice()
    flags[310] = 0x03
    expect(codeOf(() => decodeDebtMessage(debts(flags)))).toBe('Flags')
    const long = encodeDebtMessage({ type: 0x01, offer: { ...offer, memo: null } }).payload.slice(0, 344)
    long[343] = 121
    expect(codeOf(() => decodeDebtMessage(debts(Uint8Array.of(...long, ...new Uint8Array(121).fill(0x61)))))).toBe(
      'Length',
    )
    const badUtf8 = full.slice()
    badUtf8[344] = 0xff
    expect(codeOf(() => decodeDebtMessage(debts(badUtf8)))).toBe('Length')
    const joinKind = full.slice()
    joinKind[2] = 0x31
    expect(codeOf(() => decodeDebtMessage(debts(joinKind)))).toBe('Kind')
    for (const type of [0x00, 0x05, 0x10, 0x11, 0x15, 0x1a])
      expect(
        codeOf(() => decodeDebtMessage(debts(Uint8Array.of(type, ...new Uint8Array(96))))),
        `type ${type}`,
      ).toBe('Kind')
    expect(codeOf(() => decodeDebtMessage({ kind: MessageKind.Payment, payload: full }))).toBe('Kind')
    for (const reason of [0, 7]) {
      const d = encodeDebtMessage({ type: 0x03, content: content(body), reason: 1 }).payload.slice()
      d[33] = reason
      expect(
        codeOf(() => decodeDebtMessage(debts(d))),
        `reason ${reason}`,
      ).toBe('Kind')
    }
    expect(codeOf(() => decodeDebtMessage(debts(new Uint8Array(96).fill(2))))).toBe('Length')
    const one = encodeDebtMessage({ type: 0x04, states: [coSigned(state, ben, ana)] }).payload
    expect(codeOf(() => decodeDebtMessage(debts(one.subarray(0, 300))))).toBe('Length')
    expect(codeOf(() => decodeDebtMessage(debts(Uint8Array.of(0x04, 0))))).toBe('Length')
    expect(codeOf(() => decodeDebtMessage(debts(Uint8Array.of(0x04, 25, ...new Uint8Array(25 * 341)))))).toBe('Length')
  })
})

describe('offerChange', () => {
  it('collects_tab_states_before_a_stale_decline', async () => {
    const [mine, theirs] = createLoopbackPair()
    const local: unknown[][] = []
    const done = offerChange(
      mine,
      { ...offer, me: ana.key, iouDomain: IOU_DOMAIN, adopt: async (states) => void local.push(states) },
      new AbortController().signal,
    )
    await theirs.receive()
    const good = coSigned(state, ben, ana)
    const forged = { ...good, creditorSig: new Uint8Array(64) }
    await theirs.send(encodeDebtMessage({ type: 0x04, states: [forged] }))
    await tick()
    await theirs.send(encodeDebtMessage({ type: 0x04, states: [good] }))
    await tick()
    await theirs.send(encodeDebtMessage({ type: 0x03, content: content(body), reason: DeclineReason.Stale }))
    await expect(done).rejects.toMatchObject({ reason: DeclineReason.Stale })
    expect(local).toEqual([[good]])
  })

  const adopted: unknown[][] = []
  const outgoing = {
    ...offer,
    me: ana.key,
    iouDomain: IOU_DOMAIN,
    adopt: async (states: unknown[]) => void adopted.push(states),
  }
  const benSig = ben.sign(iouEnvelope(state, IOU_DOMAIN))

  it('accept_for_another_content_is_ignored', async () => {
    const [mine, theirs] = createLoopbackPair()
    const done = offerChange(mine, outgoing, new AbortController().signal)
    expect(decodeDebtMessage(await theirs.receive()).type).toBe(DebtMessageType.TabOffer)
    await theirs.send(encodeDebtMessage({ type: 0x02, content: new Uint8Array(32).fill(1), signature: benSig }))
    await tick()
    await theirs.send(encodeDebtMessage({ type: 0x02, content: content(body), signature: offer.signature }))
    await tick()
    await theirs.send(encodeDebtMessage({ type: 0x03, content: new Uint8Array(32).fill(1), reason: 1 }))
    await tick()
    await theirs.send(encodeDebtMessage({ type: 0x02, content: content(body), signature: benSig }))
    const signed = await done
    expect(signed.debtorSig).toEqual(benSig)
    expect(signed.creditorSig).toEqual(offer.signature)
  })

  it('throws TabDeclined with the reason', async () => {
    const [mine, theirs] = createLoopbackPair()
    const done = offerChange(mine, outgoing, new AbortController().signal)
    await theirs.receive()
    await theirs.send(encodeDebtMessage({ type: 0x03, content: content(body), reason: DeclineReason.Locked }))
    await expect(done).rejects.toMatchObject({ reason: DeclineReason.Locked })
  })

  it('is cancelled by its signal', async () => {
    const [mine] = createLoopbackPair()
    const controller = new AbortController()
    const done = offerChange(mine, outgoing, controller.signal)
    await tick()
    controller.abort()
    await expect(done).rejects.toBeInstanceOf(TransportError)
    await expect(done).rejects.toMatchObject({ code: 'Cancelled' })
  })
})
