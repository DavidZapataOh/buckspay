import { describe, expect, it } from 'vitest'
import type { ReceivedNote } from './ledger'
import { heldOutputs, markRespendSigned, OutputTaken, prepareRespend } from './outgoing'
import { migrate, SCHEMA } from './schema'
import { createNodeDb } from './testing/node-db'
import { seedHeld } from './testing/seed'
import { encodeBundle } from '../../payment/messages'
import { heldNote, party } from '../../payment/testing/world'
import { encodeCaveats } from '../../protocol'

const owner = new Uint8Array(33).fill(2)
const body = new Uint8Array(123).fill(7)
const ids = (n: number) => new Uint8Array(32).fill(n)

const change = heldNote({ from: party(1), to: party(2), amount: 400_000n })

const changeNote = (outputId: Uint8Array): ReceivedNote => ({
  outputId,
  messageId: ids(9),
  owner,
  mint: ids(5),
  amount: 400_000n,
  expiry: 2_000_000_000,
  hopsLeft: 1,
  caveats: encodeCaveats(change.output.caveats),
  issuer: new Uint8Array(33).fill(3),
  lockSeq: 1,
  bundle: encodeBundle(change.bundle),
  liable: [],
  claims: [],
  requestedAmount: null,
  memo: null,
  transport: 'change',
  receivedAt: 2,
})

describe('re-spend store', () => {
  it('takes the input out of held before signing', async () => {
    const db = createNodeDb()
    await seedHeld(db, { outputId: ids(1), owner })
    await prepareRespend(db, { input: ids(1), messageId: ids(9), body, requestId: ids(8), now: 1 })
    expect(await heldOutputs(db, owner)).toHaveLength(0)
  })

  it('refuses a second body for the same output', async () => {
    const db = createNodeDb()
    await seedHeld(db, { outputId: ids(1), owner })
    await prepareRespend(db, { input: ids(1), messageId: ids(9), body, requestId: ids(8), now: 1 })
    await expect(
      prepareRespend(db, {
        input: ids(1),
        messageId: ids(10),
        body: body.map((b) => b ^ 1),
        requestId: ids(7),
        now: 2,
      }),
    ).rejects.toBeInstanceOf(OutputTaken)
  })

  it('leaves nothing half-written when the transaction fails', async () => {
    const db = createNodeDb((sql) => sql.includes('INSERT INTO outgoing_payment'))
    await seedHeld(db, { outputId: ids(1), owner })
    await expect(
      prepareRespend(db, { input: ids(1), messageId: ids(9), body, requestId: ids(8), now: 1 }),
    ).rejects.toThrow()
    expect(await heldOutputs(db, owner)).toHaveLength(1)
  })

  it('after signing, the input is spent and the change is held', async () => {
    const db = createNodeDb()
    await seedHeld(db, { outputId: ids(1), owner })
    await prepareRespend(db, { input: ids(1), messageId: ids(9), body, requestId: ids(8), now: 1 })
    await markRespendSigned(db, {
      messageId: ids(9),
      signature: new Uint8Array(64),
      bundle: new Uint8Array(5),
      change: changeNote(ids(2)),
      now: 2,
    })
    expect((await heldOutputs(db, owner)).map((h) => h.outputId[0])).toEqual([2])
  })

  it('signing twice records the change once and keeps the locks that back it', async () => {
    const db = createNodeDb()
    await seedHeld(db, { outputId: ids(1), owner })
    await db.run('INSERT INTO note_liability (output_id, device, lock_seq, bond, attester) VALUES (?, ?, 1, 5, 7)', [
      ids(1),
      new Uint8Array(33).fill(3),
    ])
    await prepareRespend(db, { input: ids(1), messageId: ids(9), body, requestId: ids(8), now: 1 })
    const signed = {
      messageId: ids(9),
      signature: new Uint8Array(64),
      bundle: new Uint8Array(5),
      change: changeNote(ids(2)),
      now: 2,
    }
    await markRespendSigned(db, signed)
    await markRespendSigned(db, signed)
    expect(await db.all('SELECT output_id, device FROM note_liability WHERE output_id = ?', [ids(2)])).toHaveLength(1)
    expect(await db.all('SELECT transport FROM received_note WHERE output_id = ?', [ids(2)])).toEqual([
      { transport: 'change' },
    ])
  })

  it('does not offer a note that has expired', async () => {
    const db = createNodeDb()
    await seedHeld(db, { outputId: ids(1), owner })
    expect(await heldOutputs(db, owner, 4_000_000_000)).toHaveLength(0)
  })

  it('keeps the rows of a store from before the re-spend migration and accepts the new state', async () => {
    const db = createNodeDb()
    await db.exec(`BEGIN; ${SCHEMA} PRAGMA user_version = 1; COMMIT;`)
    await db.run(
      `INSERT INTO received_note (output_id, message_id, owner, mint, amount, expiry, hops_left, caveats, issuer, lock_seq, bundle, state,
         transport, received_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, 1, ?, ?, 1, ?, 'settled', 'qr', 1, 1)`,
      [ids(1), ids(2), owner, ids(3), ids(4), owner, ids(5)],
    )
    await migrate(db)
    expect(await db.all('SELECT state FROM received_note')).toEqual([{ state: 'settled' }])
    await db.run("UPDATE received_note SET state = 'spending'")
    expect(await db.all('SELECT state FROM received_note')).toEqual([{ state: 'spending' }])
  })
})
