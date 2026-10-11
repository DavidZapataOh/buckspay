import { bytesToHex } from '@noble/hashes/utils.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteDb } from '../features/notes/db'
import { nextCumEnd, paymentForRequest, setOutgoingState, unfinishedPayments } from '../features/notes/outgoing'
import { migrate } from '../features/notes/schema'
import { createNodeDb } from '../features/notes/testing/node-db'
import { createQrPair } from '../transport/testing/qr-pair'
import { MessageKind, type Transport } from '../transport/types'
import { encodeIssueBody } from '../protocol'
import {
  decodeBundle,
  decodeRequest,
  encodeReceipt,
  encodeRequest,
  paymentId,
  type PaymentRequest,
  requestIdOf,
} from './messages'
import { awaitReceipt, confirmAndSend, type PayDeps, PayError, resumeForRequest, resumePayments } from './pay'
import { type OfflineLock, type PayContext, planPayment } from './preflight'
import { Reason } from './reasons'
import { receivePayment, showRequest } from './receive-flow'
import { createSoftSigner } from './testing/soft-guard'
import { ATTESTER, MINT, makeTicket, NOTE_DOMAIN, party, PROGRAM, receiverFor } from './testing/world'

const payer = party(1)
const shop = party(2)
const NOW = 1_800_000_000
const LIMITS = {
  noteLifetime: 72 * 3600,
  noteHops: 3,
  requestTtl: 600,
  skewTolerance: 120,
  transferMargin: 120,
  maxPayment: 100_000_000n,
  biometricFrom: 20_000_000n,
  biometricDaily: 50_000_000n,
}
const request = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({
  owner: { type: 'device', key: shop.key },
  mint: MINT,
  amount: 5_000_000n,
  now: NOW,
  minWindow: 3600,
  minHops: 1,
  attesters: [ATTESTER.id],
  memo: 'Coffee',
  witness: 'none',
  ...over,
})

let payerDb: NoteDb
let shopDb: NoteDb
let payerSide: Transport
let shopSide: Transport
let signer: ReturnType<typeof createSoftSigner>

const lockAt = async (): Promise<OfflineLock> => ({
  lockSeq: 3,
  mint: MINT,
  bond: 200_000_000n,
  backing: 100_000_000n,
  lockUntil: NOW + 30 * 86400,
  nextCumEnd: await nextCumEnd(payerDb, payer.key, 3),
  ticket: makeTicket({
    device: payer.key,
    mint: MINT,
    lockSeq: 3,
    bond: 200_000_000n,
    backing: 100_000_000n,
    lockUntil: NOW + 30 * 86400,
  }),
})
const contextOf = async (): Promise<PayContext> => ({
  now: NOW + 20,
  me: payer.key,
  noteDomain: NOTE_DOMAIN,
  program: PROGRAM,
  locks: [await lockAt()],
  tokens: new Map([[bytesToHex(MINT), { symbol: 'USDC', decimals: 6 }]]),
  limits: LIMITS,
  salt: () => crypto.getRandomValues(new Uint8Array(16)),
  knownReceivers: new Set(),
  paidRequests: new Set(),
  paidToday: 0n,
})
const planFor = async (req: PaymentRequest, paidRequests: ReadonlySet<string> = new Set()) => {
  const ctx: PayContext = {
    now: NOW + 20,
    me: payer.key,
    noteDomain: NOTE_DOMAIN,
    program: PROGRAM,
    locks: [await lockAt()],
    tokens: new Map([[bytesToHex(MINT), { symbol: 'USDC', decimals: 6 }]]),
    limits: LIMITS,
    salt: () => crypto.getRandomValues(new Uint8Array(16)),
    knownReceivers: new Set(),
    paidRequests,
    paidToday: 0n,
  }
  const planned = planPayment(req, ctx)
  if (!planned.ok) throw new Error(planned.reason)
  return planned.plan
}
const deps = (over: Partial<PayDeps> = {}): PayDeps => ({
  db: payerDb,
  sign: signer.sign,
  transport: payerSide,
  authenticate: async () => true,
  noteDomain: NOTE_DOMAIN,
  now: () => NOW + 25,
  ...over,
})
const shopContext = (over = {}) => ({
  receiver: receiverFor(shop, { now: NOW + 40 }),
  db: shopDb,
  limits: { maxPayment: 100_000_000n },
  transport: 'qr',
  request: null,
  ...over,
})
const rows = async (db: NoteDb, table: string) =>
  (await db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0].n

beforeEach(async () => {
  payerDb = createNodeDb()
  shopDb = createNodeDb()
  await migrate(payerDb)
  await migrate(shopDb)
  ;[payerSide, shopSide] = createQrPair({ drop: 0.5, seed: 11 })
  signer = createSoftSigner(payer)
})

describe('pay and receive over QR, half the frames missed', () => {
  it('moves a payment from request to confirmed receipt', async () => {
    const req = request()
    await showRequest(req, shopSide)
    const scanned = decodeRequest((await payerSide.receive({ accept: [MessageKind.Request], timeoutMs: 5000 })).payload)
    expect(scanned).toEqual(req)
    const plan = await planFor(scanned)
    const shopWaits = receivePayment(shopContext({ request: { amount: req.amount, memo: req.memo } }), shopSide, {
      timeoutMs: 5000,
    })
    const sent = await confirmAndSend(plan, scanned, 'qr', deps())
    const outcome = await shopWaits
    expect(outcome).toMatchObject({ accepted: true, duplicate: false })
    expect(await awaitReceipt(sent, deps(), { timeoutMs: 5000 })).toEqual({ status: 'confirmed' })
    expect(await nextCumEnd(payerDb, payer.key, 3)).toBe(5_000_000n)
    expect((await payerDb.all<{ state: string }>('SELECT state FROM outgoing_payment'))[0].state).toBe('confirmed')
    expect(await rows(shopDb, 'received_note')).toBe(1)
    await Promise.all([payerSide.close(), shopSide.close()])
  })

  it('keeps what a request for money to pass on received, and settles the rest as usual', async () => {
    for (const passOn of [true, false]) {
      const req = request({ memo: passOn ? 'pass' : 'settle' })
      const [a, b] = createQrPair({ drop: 0, seed: 3 })
      await showRequest(req, b)
      const scanned = decodeRequest((await a.receive({ accept: [MessageKind.Request], timeoutMs: 5000 })).payload)
      const shopWaits = receivePayment(shopContext({ request: { amount: req.amount, memo: req.memo, passOn } }), b, {
        timeoutMs: 5000,
      })
      await confirmAndSend(await planFor(scanned), scanned, 'qr', deps({ transport: a }))
      expect(await shopWaits).toMatchObject({ accepted: true })
      await Promise.all([a.close(), b.close()])
    }
    const kept = await shopDb.all<{ memo: string; keep: number }>('SELECT memo, keep FROM received_note ORDER BY memo')
    expect(kept).toEqual([
      { memo: 'pass', keep: 1 },
      { memo: 'settle', keep: 0 },
    ])
  })

  it("shows the receiver's reason when it refuses, and keeps the interval used", async () => {
    const plan = await planFor(request())
    const shopWaits = receivePayment(shopContext({ limits: { maxPayment: 1_000_000n } }), shopSide, { timeoutMs: 5000 })
    const sent = await confirmAndSend(plan, request(), 'qr', deps())
    expect(await shopWaits).toMatchObject({ accepted: false, reason: Reason.AboveMax })
    expect(await awaitReceipt(sent, deps(), { timeoutMs: 5000 })).toEqual({
      status: 'rejected',
      reason: Reason.AboveMax,
    })
    expect(await nextCumEnd(payerDb, payer.key, 3)).toBe(5_000_000n)
    expect(await unfinishedPayments(payerDb)).toEqual([])
    const next = await planFor(request({ amount: 1_000_000n }))
    expect(next.issue.cumEnd - next.issue.amount).toBe(5_000_000n)
    await Promise.all([payerSide.close(), shopSide.close()])
  })

  it('answers a payment scanned twice as received once', async () => {
    const plan = await planFor(request())
    const first = receivePayment(shopContext(), shopSide, { timeoutMs: 5000 })
    const sent = await confirmAndSend(plan, request(), 'qr', deps())
    expect(await first).toMatchObject({ accepted: true, duplicate: false })
    const second = receivePayment(shopContext(), shopSide, { timeoutMs: 5000 })
    await payerSide.send({ kind: MessageKind.Payment, payload: sent.bundle })
    expect(await second).toMatchObject({ accepted: true, duplicate: true })
    expect(await rows(shopDb, 'received_note')).toBe(1)
    await Promise.all([payerSide.close(), shopSide.close()])
  })

  it('says so when the code scanned is not a payment, and goes on waiting for one', async () => {
    const plan = await planFor(request())
    const wrong = vi.fn()
    const shopWaits = receivePayment(shopContext(), shopSide, { timeoutMs: 5000, onWrongCode: wrong })
    await payerSide.send({ kind: MessageKind.Request, payload: encodeRequest(request()) })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(wrong).toHaveBeenCalled()
    await confirmAndSend(plan, request(), 'qr', deps())
    expect(await shopWaits).toMatchObject({ accepted: true })
    await Promise.all([payerSide.close(), shopSide.close()])
  })

  it('builds the receiver only once a payment has arrived, so its clock is the time of the check', async () => {
    const plan = await planFor(request())
    const receiver = vi.fn(async () => shopContext())
    const shopWaits = receivePayment(receiver, shopSide, { timeoutMs: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(receiver).not.toHaveBeenCalled()
    await confirmAndSend(plan, request(), 'qr', deps())
    expect(await shopWaits).toMatchObject({ accepted: true })
    expect(receiver).toHaveBeenCalledTimes(1)
    await Promise.all([payerSide.close(), shopSide.close()])
  })

  it('ignores a receipt for another payment', async () => {
    const plan = await planFor(request())
    const sent = await confirmAndSend(plan, request(), 'qr', deps())
    const waiting = awaitReceipt(sent, deps(), { timeoutMs: 5000 })
    await shopSide.send({
      kind: MessageKind.Receipt,
      payload: encodeReceipt({ accepted: true, reason: Reason.Accepted, messageId: new Uint8Array(32).fill(1) }),
    })
    expect(await waiting).toEqual({ status: 'other-payment' })
    expect((await payerDb.all<{ state: string }>('SELECT state FROM outgoing_payment'))[0].state).toBe('signed')
    await Promise.all([payerSide.close(), shopSide.close()])
  })
})

describe('what happens when the app dies', () => {
  it('signs the same stored issue again after a crash between preparing and signing, never a new one', async () => {
    const plan = await planFor(request())
    const crashing = deps({ sign: async () => Promise.reject(new Error('process died')) })
    await expect(confirmAndSend(plan, request(), 'qr', crashing)).rejects.toMatchObject({ code: 'SignFailed' })
    expect((await unfinishedPayments(payerDb)).map((p) => p.state)).toEqual(['prepared'])
    expect(await nextCumEnd(payerDb, payer.key, 3)).toBe(5_000_000n)

    const shopWaits = receivePayment(shopContext(), shopSide, { timeoutMs: 5000 })
    const [resumed] = await resumePayments(deps())
    expect(await shopWaits).toMatchObject({ accepted: true })
    expect(resumed.messageId).toEqual(
      (await payerDb.all<{ message_id: Uint8Array }>('SELECT message_id FROM outgoing_payment'))[0].message_id,
    )
    expect(signer.signatures).toBe(1)
    const [row] = await unfinishedPayments(payerDb)
    expect(row.state).toBe('signed')
    expect(encodeIssueBody(decodeBundle(resumed.bundle).issue.message)).toEqual(row.issueBody)
    expect(paymentId(NOTE_DOMAIN, decodeBundle(resumed.bundle))).toEqual(resumed.messageId)
    await Promise.all([payerSide.close(), shopSide.close()])
  })

  it('finishes the payment of a request when the same request is read again, and only then', async () => {
    const req = request()
    const failing = deps({
      transport: { ...payerSide, send: () => Promise.reject(new Error('link died')) } as unknown as Transport,
    })
    await expect(confirmAndSend(await planFor(req), req, 'nearby', failing)).rejects.toMatchObject({
      code: 'SendFailed',
    })
    const [stored] = await unfinishedPayments(payerDb)
    expect(stored).toMatchObject({ state: 'signed', transport: 'nearby' })
    expect(stored.requestId).toEqual(requestIdOf(req))
    const before = signer.signatures

    expect(await resumeForRequest(deps(), request({ memo: 'another' }))).toBeUndefined()

    const shopWaits = receivePayment(shopContext(), shopSide, { timeoutMs: 5000 })
    const resumed = await resumeForRequest(deps(), req)
    expect(resumed?.messageId).toEqual(stored.messageId)
    expect(resumed?.bundle).toEqual(stored.bundle)
    expect(await shopWaits).toMatchObject({ accepted: true })
    expect(signer.signatures).toBe(before)
    expect(await rows(payerDb, 'outgoing_payment')).toBe(1)
    await Promise.all([payerSide.close(), shopSide.close()])
  })

  it('does not send again a payment that was confirmed, and does nothing for a request never paid', async () => {
    const req = request()
    expect(await resumeForRequest(deps(), req)).toBeUndefined()
    await confirmAndSend(await planFor(req), req, 'qr', deps())
    const live = await paymentForRequest(payerDb, requestIdOf(req))
    await setOutgoingState(payerDb, live!.messageId, 'confirmed', NOW + 5)
    expect(await resumeForRequest(deps(), req)).toBeUndefined()
  })

  it('refuses to sign a stored issue that is no longer the one the payment id names', async () => {
    const crashing = deps({ sign: async () => Promise.reject(new Error('process died')) })
    await expect(confirmAndSend(await planFor(request()), request(), 'qr', crashing)).rejects.toBeInstanceOf(PayError)
    const other = await planFor(request({ amount: 1_000_000n }))
    await payerDb.run('UPDATE outgoing_payment SET issue_body = ?', [encodeIssueBody(other.issue)])
    await expect(resumePayments(deps())).rejects.toMatchObject({ code: 'Mismatch' })
    expect(signer.signatures).toBe(0)
    await Promise.all([payerSide.close(), shopSide.close()])
  })

  it('resumes only the payment it is asked for', async () => {
    const crashing = deps({ sign: async () => Promise.reject(new Error('process died')) })
    const first = request()
    const second = request({ amount: 1_000_000n })
    await expect(confirmAndSend(await planFor(first), first, 'qr', crashing)).rejects.toBeInstanceOf(PayError)
    await expect(confirmAndSend(await planFor(second), second, 'qr', crashing)).rejects.toBeInstanceOf(PayError)
    const [one, two] = await unfinishedPayments(payerDb)
    const resumed = await resumePayments(deps(), two.messageId)
    expect(resumed.map((payment) => payment.messageId)).toEqual([two.messageId])
    expect((await unfinishedPayments(payerDb)).map((row) => row.state)).toEqual(['prepared', 'signed'])
    expect(one.state).toBe('prepared')
    await Promise.all([payerSide.close(), shopSide.close()])
  })

  it('keeps the native error code so the screen can say what to do', async () => {
    const plan = await planFor(request())
    const locked = deps({
      sign: () => Promise.reject(Object.assign(new Error('locked'), { code: 'ERR_DEVICE_LOCKED' })),
    })
    const error = await confirmAndSend(plan, request(), 'qr', locked).catch((e) => e)
    expect(error).toMatchObject({ code: 'SignFailed', cause: { code: 'ERR_DEVICE_LOCKED' } })
  })

  it('shows the stored bytes again after a crash after signing, byte for byte, without signing', async () => {
    const plan = await planFor(request())
    const failing = deps({
      transport: { ...payerSide, send: () => Promise.reject(new Error('screen died')) } as unknown as Transport,
    })
    await expect(confirmAndSend(plan, request(), 'qr', failing)).rejects.toMatchObject({ code: 'SendFailed' })
    const [stored] = await unfinishedPayments(payerDb)
    expect(stored.state).toBe('signed')
    const before = signer.signatures

    const shopWaits = receivePayment(shopContext(), shopSide, { timeoutMs: 5000 })
    const [resumed] = await resumePayments(deps())
    expect(resumed.bundle).toEqual(stored.bundle)
    expect(await shopWaits).toMatchObject({ accepted: true })
    expect(signer.signatures).toBe(before)
    await Promise.all([payerSide.close(), shopSide.close()])
  })

  it('never signs a different issue for an interval it already prepared', async () => {
    const plan = await planFor(request())
    await expect(
      confirmAndSend(plan, request(), 'qr', deps({ sign: async () => Promise.reject(new Error('died')) })),
    ).rejects.toBeInstanceOf(PayError)
    const stale = { ...plan, issue: { ...plan.issue, salt: new Uint8Array(16).fill(1) } }
    await expect(confirmAndSend(stale, request(), 'qr', deps())).rejects.toMatchObject({ code: 'IntervalTaken' })
    expect(signer.signatures).toBe(0)
  })
})

describe('taps and confirmation', () => {
  it('lets only one of two quick taps through: the second finds the interval taken', async () => {
    const plan = await planFor(request())
    const results = await Promise.allSettled([
      confirmAndSend(plan, request(), 'qr', deps()),
      confirmAndSend(plan, request(), 'qr', deps()),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(failed?.reason).toMatchObject({ code: 'IntervalTaken' })
    expect(signer.signatures).toBe(1)
    expect(await rows(payerDb, 'outgoing_payment')).toBe(1)
  })

  it('signs nothing and moves no cursor when the person declines the biometric prompt', async () => {
    const plan = await planFor(request({ amount: 20_000_000n }))
    expect(plan.review.biometric).toBe(true)
    await expect(
      confirmAndSend(plan, request({ amount: 20_000_000n }), 'qr', deps({ authenticate: async () => false })),
    ).rejects.toMatchObject({ code: 'Declined' })
    expect(signer.signatures).toBe(0)
    expect(await nextCumEnd(payerDb, payer.key, 3)).toBe(0n)
    expect(await rows(payerDb, 'outgoing_payment')).toBe(0)
  })

  it('does not ask for a biometric below the threshold', async () => {
    let asked = 0
    const plan = await planFor(request())
    await confirmAndSend(plan, request(), 'qr', deps({ authenticate: async () => (asked++, true) }))
    expect(asked).toBe(0)
  })

  it('refuses to pay the same request twice while the first payment lives, and allows it after a rejection', async () => {
    const req = request()
    await confirmAndSend(await planFor(req), req, 'qr', deps())
    const live = await paymentForRequest(payerDb, requestIdOf(req))
    expect(live?.state).toBe('signed')
    expect(
      planPayment(req, { ...(await contextOf()), paidRequests: new Set([bytesToHex(requestIdOf(req))]) }),
    ).toMatchObject({ ok: false, reason: 'AlreadyPaid' })
    await setOutgoingState(payerDb, live!.messageId, 'rejected', NOW + 30, Reason.AboveMax)
    expect(await paymentForRequest(payerDb, requestIdOf(req))).toBeUndefined()
  })

  it('pays two receivers in a row from one lock with adjacent intervals', async () => {
    const first = await planFor(request())
    await confirmAndSend(first, request(), 'qr', deps())
    const second = await planFor(request({ amount: 2_000_000n }))
    await confirmAndSend(second, request({ amount: 2_000_000n }), 'qr', deps())
    const intervals = await payerDb.all<{ cum_start: number; cum_end: number }>(
      'SELECT cum_start, cum_end FROM outgoing_payment ORDER BY cum_start',
    )
    expect(intervals).toEqual([
      { cum_start: 0, cum_end: 5_000_000 },
      { cum_start: 5_000_000, cum_end: 7_000_000 },
    ])
  })
})
