import { beforeEach, describe, expect, it } from 'vitest'
import type { NoteDb } from '../features/notes/db'
import { heldOutputs, unfinishedPayments } from '../features/notes/outgoing'
import { migrate } from '../features/notes/schema'
import { createNodeDb } from '../features/notes/testing/node-db'
import { seedHeld } from '../features/notes/testing/seed'
import { createQrPair } from '../transport/testing/qr-pair'
import { encodeSpendBody } from '../protocol'
import type { Transport } from '../transport/types'
import { confirmAndSendRespend, type PayDeps, resumePayments } from './pay'
import { planRespend, type RespendPlan } from './respend'
import { receivePayment } from './receive-flow'
import { createSoftSpendSigner } from './testing/soft-guard'
import { heldNote, NOTE_DOMAIN, NOW, party, payCtx, receiverFor, requestTo } from './testing/world'

const issuer = party(1)
const me = party(2)
const shop = party(3)

let myDb: NoteDb
let shopDb: NoteDb
let mySide: Transport
let shopSide: Transport
let signer: ReturnType<typeof createSoftSpendSigner>
let plan: RespendPlan

const deps = (over: Partial<PayDeps> = {}) => ({
  db: myDb,
  sign: async () => Promise.reject(new Error('an issue is never signed here')),
  signSpend: signer.signSpend,
  transport: mySide,
  authenticate: async () => true,
  noteDomain: NOTE_DOMAIN,
  now: () => NOW + 25,
  ...over,
})
const shopContext = () => ({
  receiver: receiverFor(shop, { now: NOW + 40 }),
  db: shopDb,
  limits: { maxPayment: 100_000_000n },
  transport: 'qr',
  request: null,
})

beforeEach(async () => {
  myDb = createNodeDb()
  shopDb = createNodeDb()
  await migrate(shopDb)
  ;[mySide, shopSide] = createQrPair({ drop: 0.5, seed: 11 })
  signer = createSoftSpendSigner(me)
  const held = heldNote({ from: issuer, to: me, amount: 5_000_000n })
  await seedHeld(myDb, { outputId: held.outputId, owner: me.key, note: held })
  const planned = planRespend(requestTo(shop, 2_000_000n), await heldOutputs(myDb, me.key), payCtx(me))
  if (!planned.ok) throw new Error(planned.reason)
  plan = planned.plan
})

describe('passing a received note on, and what happens when the app dies', () => {
  it('pays from the held note, keeps the change and the receiver accepts', async () => {
    const shopWaits = receivePayment(shopContext(), shopSide, { timeoutMs: 5000 })
    const sent = await confirmAndSendRespend(plan, requestTo(shop, 2_000_000n), 'qr', deps())
    expect(await shopWaits).toMatchObject({ accepted: true })
    expect(sent.messageId).toHaveLength(32)
    const held = await heldOutputs(myDb, me.key)
    expect(held.map((h) => h.output.amount)).toEqual([3_000_000n])
    expect((await myDb.all("SELECT state FROM received_note WHERE state = 'spent'")).length).toBe(1)
    await Promise.all([mySide.close(), shopSide.close()])
  })

  it('signs the same stored body again after a crash between preparing and signing', async () => {
    const crashing = deps({ signSpend: () => Promise.reject(new Error('process died')) })
    await expect(confirmAndSendRespend(plan, requestTo(shop, 2_000_000n), 'qr', crashing)).rejects.toMatchObject({
      code: 'SignFailed',
    })
    const [row] = await unfinishedPayments(myDb)
    expect(row.state).toBe('prepared')
    expect(row.issueBody).toEqual(encodeSpendBody(plan.spend))
    expect(await heldOutputs(myDb, me.key)).toHaveLength(0)

    const shopWaits = receivePayment(shopContext(), shopSide, { timeoutMs: 5000 })
    const [resumed] = await resumePayments(deps())
    expect(await shopWaits).toMatchObject({ accepted: true })
    expect(resumed.messageId).toEqual(row.messageId)
    expect(signer.signatures).toBe(1)
    expect((await heldOutputs(myDb, me.key)).map((h) => h.output.amount)).toEqual([3_000_000n])
    await Promise.all([mySide.close(), shopSide.close()])
  })

  it('shows the stored bytes again after a crash after signing, without signing', async () => {
    const failing = deps({
      transport: { ...mySide, send: () => Promise.reject(new Error('screen died')) } as unknown as Transport,
    })
    await expect(confirmAndSendRespend(plan, requestTo(shop, 2_000_000n), 'qr', failing)).rejects.toMatchObject({
      code: 'SendFailed',
    })
    const [stored] = await unfinishedPayments(myDb)
    expect(stored.state).toBe('signed')
    const before = signer.signatures

    const shopWaits = receivePayment(shopContext(), shopSide, { timeoutMs: 5000 })
    const [resumed] = await resumePayments(deps())
    expect(resumed.bundle).toEqual(stored.bundle)
    expect(await shopWaits).toMatchObject({ accepted: true })
    expect(signer.signatures).toBe(before)
    await Promise.all([mySide.close(), shopSide.close()])
  })

  it('stores the change as a held row of its own, marked as change', async () => {
    const shopWaits = receivePayment(shopContext(), shopSide, { timeoutMs: 5000 })
    await confirmAndSendRespend(plan, requestTo(shop, 2_000_000n), 'qr', deps())
    await shopWaits
    expect(await myDb.all("SELECT transport FROM received_note WHERE state = 'held'")).toEqual([
      { transport: 'change' },
    ])
    await Promise.all([mySide.close(), shopSide.close()])
  })

  it('keeps the change for passing on, because it is money the person has not decided to settle', async () => {
    const shopWaits = receivePayment(shopContext(), shopSide, { timeoutMs: 5000 })
    await confirmAndSendRespend(plan, requestTo(shop, 2_000_000n), 'qr', deps())
    await shopWaits
    expect(await myDb.all("SELECT keep FROM received_note WHERE transport = 'change'")).toEqual([{ keep: 1 }])
    await Promise.all([mySide.close(), shopSide.close()])
  })

  it('sends nothing when the device signed another spend than the stored one', async () => {
    const other = deps({
      signSpend: async (input, spend) => ({
        message: { ...spend, salt: new Uint8Array(16).fill(1) },
        signature: (await signer.signSpend(input, spend)).signature,
      }),
    })
    await expect(confirmAndSendRespend(plan, requestTo(shop, 2_000_000n), 'qr', other)).rejects.toMatchObject({
      code: 'Mismatch',
    })
    expect(await heldOutputs(myDb, me.key)).toHaveLength(0)
    expect((await unfinishedPayments(myDb))[0].bundle).toBeNull()
    await Promise.all([mySide.close(), shopSide.close()])
  })

  it('writes nothing when the person declines the confirmation', async () => {
    const asking = { ...plan, review: { ...plan.review, biometric: true } }
    await expect(
      confirmAndSendRespend(asking, requestTo(shop, 2_000_000n), 'qr', deps({ authenticate: async () => false })),
    ).rejects.toMatchObject({ code: 'Declined' })
    expect(await unfinishedPayments(myDb)).toHaveLength(0)
    expect(await heldOutputs(myDb, me.key)).toHaveLength(1)
    expect(signer.signatures).toBe(0)
    await Promise.all([mySide.close(), shopSide.close()])
  })

  it('refuses to pay the same note twice', async () => {
    const shopWaits = receivePayment(shopContext(), shopSide, { timeoutMs: 5000 })
    await confirmAndSendRespend(plan, requestTo(shop, 2_000_000n), 'qr', deps())
    await shopWaits
    await expect(
      confirmAndSendRespend(plan, requestTo(shop, 2_000_000n, { memo: 'again' }), 'qr', deps()),
    ).rejects.toMatchObject({ code: 'IntervalTaken' })
    expect(signer.signatures).toBe(1)
    await Promise.all([mySide.close(), shopSide.close()])
  })
})
