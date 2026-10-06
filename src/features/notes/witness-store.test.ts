import { beforeEach, describe, expect, it } from 'vitest'
import { encodeBundle } from '../../payment/messages'
import { makeTicket, MINT, party, signIssue } from '../../payment/testing/world'
import type { Issue } from '../../protocol'
import type { NoteDb } from './db'
import { migrate } from './schema'
import { createNodeDb } from './testing/node-db'
import { createWitnessStore, migrateWitness } from './witness-store'

const payer = party(1)
const shop = party(2)
const NOW = 1_800_000_000
const issue = (): Issue => ({
  issuer: payer.key,
  mint: MINT,
  lockSeq: 3,
  cumEnd: 7_000_000n,
  salt: new Uint8Array(16).fill(7),
  owner: { type: 'device', key: shop.key },
  amount: 5_000_000n,
  caveats: { expiry: NOW + 72 * 3600, hopsLeft: 3, flags: 0, scopeKind: 0, scope: new Uint8Array(20) },
})
const bundle = () =>
  encodeBundle({
    issue: signIssue(payer, issue()),
    spends: [],
    tickets: [
      makeTicket({
        device: payer.key,
        mint: MINT,
        lockSeq: 3,
        bond: 50_000_000n,
        backing: 100_000_000n,
        lockUntil: NOW + 86400 * 30,
      }),
    ],
  })

const id = (n: number) => new Uint8Array(32).fill(n)
const outputOf = (messageId: Uint8Array) => id(messageId[0] + 100)
let db: NoteDb

async function insertNote(messageId: Uint8Array, owner: Uint8Array, wire: Uint8Array = bundle()) {
  await db.run(
    `INSERT INTO received_note (output_id, message_id, owner, mint, amount, expiry, hops_left, caveats, issuer, lock_seq, bundle, state, transport, received_at, updated_at)
     VALUES (?, ?, ?, ?, 5000000, 1, 3, ?, ?, 3, ?, 'held', 'qr', 1, 1)`,
    [outputOf(messageId), messageId, owner, MINT, new Uint8Array(27), payer.key, wire],
  )
}

async function insertPayment(messageId: Uint8Array, state: string, receiver: Uint8Array = shop.key) {
  await db.run(
    `INSERT INTO outgoing_payment (message_id, device, state, receiver, mint, amount, lock_seq, cum_start, cum_end, expiry, issue_body, ticket, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 5000000, 3, ?, ?, 1, ?, ?, 1, 1)`,
    [
      messageId,
      payer.key,
      state,
      receiver,
      MINT,
      messageId[0],
      messageId[0] + 5_000_000,
      new Uint8Array(1),
      new Uint8Array(1),
    ],
  )
}

beforeEach(async () => {
  db = createNodeDb()
  await migrate(db)
  await migrateWitness(db)
})

const version = async () => (await db.all<{ user_version: number }>('PRAGMA user_version'))[0].user_version

describe('migrateWitness', () => {
  it('adds the two columns, moves the version to 2 and keeps what was there', async () => {
    const fresh = createNodeDb()
    await migrate(fresh)
    await fresh.run(
      `INSERT INTO outgoing_payment (message_id, device, state, receiver, mint, amount, lock_seq, cum_start, cum_end, expiry, issue_body, ticket, created_at, updated_at)
       VALUES (?, ?, 'signed', ?, ?, 1, 0, 0, 1, 1, ?, ?, 1, 1)`,
      [id(1), payer.key, shop.key, MINT, new Uint8Array(1), new Uint8Array(1)],
    )
    await migrateWitness(fresh)
    const [row] = await fresh.all<{ witness: Uint8Array | null; witness_signed: number }>(
      'SELECT witness, witness_signed FROM outgoing_payment',
    )
    expect(row).toEqual({ witness: null, witness_signed: 0 })
    expect((await fresh.all<{ user_version: number }>('PRAGMA user_version'))[0].user_version).toBe(5)
  })

  it('runs twice without harm', async () => {
    await migrateWitness(db)
    expect(await version()).toBe(5)
  })

  it('refuses a database that is not at version 1', async () => {
    const empty = createNodeDb()
    await expect(migrateWitness(empty)).rejects.toThrow('version 1')
  })
})

describe('the facts of a payment', () => {
  it('for the receiver: its own key and the issuer of the first payment', async () => {
    await insertNote(id(1), shop.key)
    expect(await createWitnessStore(db).facts(id(1), 'receiver')).toEqual({
      payerKey: payer.key,
      receiverKey: shop.key,
    })
  })

  it('for the receiver: nothing for an unknown payment, an account owner, or a chain', async () => {
    const store = createWitnessStore(db)
    expect(await store.facts(id(9), 'receiver')).toBeNull()
    await insertNote(id(2), new Uint8Array(33))
    expect(await store.facts(id(2), 'receiver')).toBeNull()
    await insertNote(id(3), shop.key)
    expect(await createWitnessStore(db, () => null).facts(id(3), 'receiver')).toBeNull()
  })

  it('for the payer: its own key and the receiver it paid, once the payment was signed', async () => {
    for (const state of ['signed', 'confirmed']) {
      const messageId = id(state === 'signed' ? 4 : 5)
      await insertPayment(messageId, state)
      expect(await createWitnessStore(db).facts(messageId, 'payer')).toEqual({
        payerKey: payer.key,
        receiverKey: shop.key,
      })
    }
  })

  it('for the payer: nothing before signing, after a refusal or an abandon, for an account receiver, or for another payment', async () => {
    const store = createWitnessStore(db)
    for (const [n, state] of [
      [6, 'prepared'],
      [7, 'rejected'],
      [8, 'abandoned'],
    ] as const) {
      await insertPayment(id(n), state)
      expect(await store.facts(id(n), 'payer')).toBeNull()
    }
    await insertPayment(id(10), 'signed', new Uint8Array(33))
    expect(await store.facts(id(10), 'payer')).toBeNull()
    expect(await store.facts(id(99), 'payer')).toBeNull()
  })
})

describe('the evidence and the count', () => {
  it('stores the evidence on the row of the right side and reads it back', async () => {
    await insertNote(id(1), shop.key)
    await insertPayment(id(2), 'signed')
    const store = createWitnessStore(db)
    expect(await store.stored(id(1), 'receiver')).toBeNull()
    await store.record(id(1), 'receiver', Uint8Array.of(1, 2, 3))
    await store.record(id(2), 'payer', Uint8Array.of(4, 5))
    expect(await store.stored(id(1), 'receiver')).toEqual(Uint8Array.of(1, 2, 3))
    expect(await store.stored(id(2), 'payer')).toEqual(Uint8Array.of(4, 5))
    expect(await store.stored(id(1), 'payer')).toBeNull()
  })

  it('counts signatures per payment, across a restart of the store', async () => {
    await insertPayment(id(1), 'signed')
    await insertPayment(id(2), 'signed')
    expect(await createWitnessStore(db).countSignature(id(1))).toBe(1)
    expect(await createWitnessStore(db).countSignature(id(1))).toBe(2)
    expect(await createWitnessStore(db).countSignature(id(2))).toBe(1)
  })

  it('counts concurrent signatures one by one', async () => {
    await insertPayment(id(1), 'signed')
    const store = createWitnessStore(db)
    const totals = await Promise.all(Array.from({ length: 6 }, () => store.countSignature(id(1))))
    expect([...totals].sort()).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('answers Infinity for a payment this phone did not make, so nothing is signed for it', async () => {
    expect(await createWitnessStore(db).countSignature(id(77))).toBe(Number.POSITIVE_INFINITY)
  })
})
