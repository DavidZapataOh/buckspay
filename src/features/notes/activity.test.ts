import { beforeEach, describe, expect, it } from 'vitest'
import { activityDetail, listActivity } from './activity'
import type { NoteDb } from './db'
import { bytesToHex } from '@noble/hashes/utils.js'
import { commitReceived, holdUntil, releaseHold, type ReceivedNote } from './ledger'
import { queueSealed } from '../relay/outbox'
import { sealedFixture } from '../relay/testing'
import { preparePayment, setOutgoingState } from './outgoing'
import { migrate } from './schema'
import { createNodeDb } from './testing/node-db'

const bytes = (n: number, length = 32) => new Uint8Array(length).fill(n)
let db: NoteDb
beforeEach(async () => {
  db = createNodeDb()
  await migrate(db)
})

const paid = (n: number, at: number, cumStart: bigint) =>
  preparePayment(db, {
    messageId: bytes(n),
    device: bytes(1, 33),
    requestId: null,
    receiver: bytes(2, 33),
    mint: bytes(3),
    amount: BigInt(n) * 1_000_000n,
    lockSeq: 3,
    cumStart,
    cumEnd: cumStart + BigInt(n) * 1_000_000n,
    expiry: 2_000_000_000,
    issueBody: bytes(4, 163),
    ticket: bytes(5, 161),
    memo: 'coffee',
    transport: 'qr',
    now: at,
  })
const received = (n: number, at: number): ReceivedNote => ({
  outputId: bytes(100 + n),
  messageId: bytes(50 + n),
  owner: bytes(1, 33),
  mint: bytes(3),
  amount: BigInt(n) * 1_000_000n,
  expiry: 2_000_000_000,
  hopsLeft: 3,
  caveats: new Uint8Array(27),
  issuer: bytes(9, 33),
  lockSeq: 1,
  bundle: bytes(7, 391),
  liable: [{ device: bytes(9, 33), lockSeq: 1, bond: 900_000_000n, attester: 7 }],
  claims: [],
  requestedAmount: null,
  memo: null,
  transport: 'qr',
  receivedAt: at,
})

describe('listActivity', () => {
  it('lists payments made and notes received together, newest first', async () => {
    await paid(1, 100, 0n)
    await commitReceived(db, received(2, 200), { maxPayment: 10n ** 12n })
    await paid(3, 300, 1_000_000n)
    const rows = await listActivity(db, 10)
    expect(rows.map((r) => [r.kind, r.amount, r.at])).toEqual([
      ['paid', 3_000_000n, 300],
      ['received', 2_000_000n, 200],
      ['paid', 1_000_000n, 100],
    ])
  })

  it('names the other party, the state, the memo and the reason of a refusal', async () => {
    await paid(1, 100, 0n)
    await setOutgoingState(db, bytes(1), 'rejected', 110, 11)
    await commitReceived(db, received(2, 200), { maxPayment: 10n ** 12n })
    const [receivedRow, paidRow] = await listActivity(db, 10)
    expect(paidRow).toMatchObject({ state: 'rejected', reason: 11, memo: 'coffee', counterparty: bytes(2, 33) })
    expect(receivedRow).toMatchObject({ state: 'held', reason: null, counterparty: bytes(9, 33) })
  })

  it('pages with a limit and a time to start before', async () => {
    for (let i = 1; i <= 5; i++) await paid(i, i * 100, (BigInt(i * (i - 1)) / 2n) * 1_000_000n)
    const first = await listActivity(db, 2)
    expect(first.map((r) => r.at)).toEqual([500, 400])
    expect((await listActivity(db, 2, 400)).map((r) => r.at)).toEqual([300, 200])
  })

  it("carries nothing about anyone's bond or balance", async () => {
    await commitReceived(db, received(2, 200), { maxPayment: 10n ** 12n })
    const [row] = await listActivity(db, 1)
    expect(Object.keys(row).sort()).toEqual([
      'amount',
      'at',
      'counterparty',
      'handedTo',
      'id',
      'kind',
      'memo',
      'payee',
      'reason',
      'remote',
      'state',
    ])
  })
})

describe('activityDetail', () => {
  it('reads a payment made with the way it was shown and its reason, and says it is unfinished until it is', async () => {
    await paid(1, 100, 0n)
    expect(await activityDetail(db, 'paid', bytes(1))).toMatchObject({
      kind: 'paid',
      amount: 1_000_000n,
      state: 'prepared',
      transport: 'qr',
      memo: 'coffee',
      expiry: 2_000_000_000,
      unfinished: true,
    })
    await setOutgoingState(db, bytes(1), 'rejected', 110, 11)
    expect(await activityDetail(db, 'paid', bytes(1))).toMatchObject({
      state: 'rejected',
      reason: 11,
      unfinished: false,
    })
  })

  it('reads a note received with the locks that back it as numbers, never their bonds', async () => {
    await commitReceived(db, received(2, 200), { maxPayment: 10n ** 12n })
    const detail = await activityDetail(db, 'received', bytes(52))
    expect(detail).toMatchObject({ kind: 'received', state: 'held', outputId: bytes(102), locks: [1], transport: 'qr' })
    expect(JSON.stringify(detail, (_, value) => (typeof value === 'bigint' ? value.toString() : value))).not.toContain(
      '900000000',
    )
  })

  it('lists a note kept for passing on as ready to pass on, with the moment it settles, until the person releases it', async () => {
    await commitReceived(db, { ...received(2, 200), keep: true }, { maxPayment: 10n ** 12n })
    expect((await listActivity(db, 10)).map((row) => row.state)).toEqual(['passable'])
    expect(await activityDetail(db, 'received', bytes(52))).toMatchObject({
      state: 'passable',
      keepUntil: holdUntil(200, 2_000_000_000),
    })
    await releaseHold(db, bytes(102))
    expect((await listActivity(db, 10)).map((row) => row.state)).toEqual(['held'])
    expect((await activityDetail(db, 'received', bytes(52)))?.keepUntil).toBeUndefined()
  })

  it('lists the change of a re-spend as change and the note it came from as passed on', async () => {
    await commitReceived(db, { ...received(1, 100), transport: 'change' }, { maxPayment: 10n ** 12n })
    await commitReceived(db, received(2, 200), { maxPayment: 10n ** 12n })
    await db.run("UPDATE received_note SET state = 'spent' WHERE output_id = ?", [bytes(102)])
    expect((await listActivity(db, 10)).map((row) => row.state)).toEqual(['spent', 'change'])
  })

  it('is nothing for a row that does not exist, or one from the other table', async () => {
    await paid(1, 100, 0n)
    expect(await activityDetail(db, 'paid', bytes(9))).toBeUndefined()
    expect(await activityDetail(db, 'received', bytes(1))).toBeUndefined()
  })

  it('says where a held note is on its way through a phone nearby', async () => {
    await commitReceived(db, received(2, 200), { maxPayment: 10n ** 12n })
    const stage = async () => {
      const [row] = await listActivity(db, 10)
      return [row.state, row.handedTo]
    }
    expect(await stage()).toEqual(['held', null])
    await queueSealed(db, {
      id: bytes(9),
      ref: bytesToHex(bytes(102)),
      sealed: sealedFixture(1),
      now: 5,
      expiresAt: 9_000,
    })
    expect(await stage()).toEqual(['relay-waiting', 0])
    await db.run('UPDATE relay_outbox SET stored_by = 2')
    expect(await stage()).toEqual(['relay-handed', 2])
    await db.run("UPDATE relay_outbox SET answer = 'retry'")
    expect((await stage())[0]).toBe('relay-waiting')
    await db.run("UPDATE relay_outbox SET answer = 'submitted'")
    expect((await stage())[0]).toBe('relay-sent')
    await db.run("UPDATE received_note SET state = 'settled'")
    expect((await stage())[0]).toBe('settled')
  })
})
