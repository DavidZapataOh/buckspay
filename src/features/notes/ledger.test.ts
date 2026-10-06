import { beforeEach, describe, expect, it } from 'vitest'
import type { NoteDb } from './db'
import {
  type Claim,
  commitReceived,
  markSettlementSigned,
  prepareSettlement,
  reconcileIdentity,
  type ReceivedNote,
  relianceByAttester,
  setNoteState,
  settleable,
} from './ledger'
import { admit, lockCapacity } from './policy'
import { migrate } from './schema'
import { createNodeDb } from './testing/node-db'

const id = (n: number, fill = n) => new Uint8Array(32).fill(fill).map((v, i) => (i === 0 ? n : v))
const LIMITS = { maxPayment: 100_000_000n }
const ME = new Uint8Array(33).fill(7)
const ISSUER = id(1)
const LOCK = { device: ISSUER, lockSeq: 3, bond: 100_000_000n, attester: 7 }

function issueClaim(start: bigint, end: bigint, content: number): Claim {
  return {
    kind: 'issue',
    issuer: ISSUER,
    lockSeq: 3,
    start,
    end,
    content: id(content),
    wire: Uint8Array.of(content, 1),
  }
}

let seq = 0
function note(overrides: Partial<ReceivedNote> & { amount: bigint }): ReceivedNote {
  seq++
  return {
    outputId: id(100 + seq),
    messageId: id(200 + seq),
    owner: ME,
    mint: id(9),
    expiry: 2_000_000_000,
    hopsLeft: 3,
    caveats: new Uint8Array(27),
    issuer: ISSUER,
    lockSeq: 3,
    bundle: Uint8Array.of(seq),
    liable: [LOCK],
    claims: [],
    requestedAmount: null,
    memo: null,
    transport: 'qr',
    receivedAt: 1_000,
    ...overrides,
  }
}

let db: NoteDb
beforeEach(async () => {
  seq = 0
  db = createNodeDb()
  await migrate(db)
})

const count = async (table: string) => (await db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0].n

describe('commitReceived', () => {
  it('stores an accepted note with its bundle, its liabilities and its claims', async () => {
    const accepted = note({ amount: 5_000_000n, claims: [issueClaim(0n, 5_000_000n, 11)] })
    expect(await commitReceived(db, accepted, LIMITS)).toEqual({ status: 'accepted' })
    const [row] = await db.all<{ state: string; amount: number; bundle: Uint8Array }>(
      'SELECT state, amount, bundle FROM received_note',
    )
    expect(row.state).toBe('held')
    expect(row.amount).toBe(5_000_000)
    expect(row.bundle).toEqual(accepted.bundle)
    expect(await count('note_liability')).toBe(1)
    expect(await count('issue_claim')).toBe(1)
  })

  it('answers duplicate for the same output and changes nothing', async () => {
    const first = note({ amount: 5_000_000n, claims: [issueClaim(0n, 5_000_000n, 11)] })
    await commitReceived(db, first, LIMITS)
    expect(await commitReceived(db, first, LIMITS)).toEqual({ status: 'duplicate' })
    expect(await count('received_note')).toBe(1)
    expect(await count('issue_claim')).toBe(1)
  })

  it('refuses a payment above the receiver maximum', async () => {
    expect(
      await commitReceived(db, note({ amount: 100_000_001n, liable: [{ ...LOCK, bond: 900_000_000n }] }), LIMITS),
    ).toEqual({
      status: 'refused',
      reason: 'AboveMax',
    })
    expect(await count('received_note')).toBe(0)
  })

  it('refuses an amount a SQLite integer and a JS number cannot hold exactly', async () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 1n
    expect(await commitReceived(db, note({ amount: huge }), { maxPayment: huge * 2n })).toEqual({
      status: 'refused',
      reason: 'AboveMax',
    })
  })

  it('keeps the unsettled total per lock within its capacity, to the unit', async () => {
    expect(lockCapacity(LOCK.bond)).toBe(50_000_000n)
    expect((await commitReceived(db, note({ amount: 30_000_000n }), LIMITS)).status).toBe('accepted')
    expect((await commitReceived(db, note({ amount: 20_000_000n }), LIMITS)).status).toBe('accepted')
    expect(await commitReceived(db, note({ amount: 1n }), LIMITS)).toEqual({ status: 'refused', reason: 'OverLimit' })
    expect(await count('received_note')).toBe(2)
  })

  it('counts a note whose settlement is signed and not yet answered, as much as one still held', async () => {
    const first = note({ amount: 25_000_000n })
    await commitReceived(db, first, LIMITS)
    await prepareSettlement(db, first.outputId, Uint8Array.of(1), 10)
    await markSettlementSigned(db, first.outputId, Uint8Array.of(2), 11)
    const [row] = await db.all<{ state: string }>('SELECT state FROM received_note WHERE output_id = ?', [
      first.outputId,
    ])
    expect(row.state).toBe('settling')
    expect(await commitReceived(db, note({ amount: 25_000_000n }), LIMITS)).toEqual({ status: 'accepted' })
    expect(await commitReceived(db, note({ amount: 1n }), LIMITS)).toEqual({ status: 'refused', reason: 'OverLimit' })
  })

  it('counts every lock that backs a payment, and another lock separately', async () => {
    const other = { device: id(2), lockSeq: 1, bond: 20_000_000n, attester: 7 }
    expect((await commitReceived(db, note({ amount: 8_000_000n, liable: [LOCK, other] }), LIMITS)).status).toBe(
      'accepted',
    )
    expect(await commitReceived(db, note({ amount: 5_000_000n, liable: [other] }), LIMITS)).toEqual({
      status: 'refused',
      reason: 'OverLimit',
    })
    expect((await commitReceived(db, note({ amount: 10_000_000n, liable: [LOCK] }), LIMITS)).status).toBe('accepted')
  })

  it("frees a lock's capacity when its notes settle or are lost, and not before", async () => {
    const first = note({ amount: 50_000_000n })
    await commitReceived(db, first, LIMITS)
    await setNoteState(db, first.outputId, 'settling', 5)
    expect((await commitReceived(db, note({ amount: 1n }), LIMITS)).status).toBe('refused')
    await setNoteState(db, first.outputId, 'settled', 6)
    expect((await commitReceived(db, note({ amount: 50_000_000n }), LIMITS)).status).toBe('accepted')
    await setNoteState(
      db,
      (await db.all<{ output_id: Uint8Array }>("SELECT output_id FROM received_note WHERE state = 'held'"))[0]
        .output_id,
      'lost',
      7,
    )
    expect((await commitReceived(db, note({ amount: 50_000_000n }), LIMITS)).status).toBe('accepted')
  })

  it('refuses an issue whose interval overlaps one already seen with another content, and keeps both as evidence', async () => {
    const honest = note({ amount: 5_000_000n, claims: [issueClaim(0n, 5_000_000n, 11)] })
    await commitReceived(db, honest, LIMITS)
    const clash = note({ amount: 4_000_000n, claims: [issueClaim(3_000_000n, 7_000_000n, 12)] })
    expect(await commitReceived(db, clash, LIMITS)).toEqual({ status: 'refused', reason: 'DoubleSpend' })
    expect(await count('received_note')).toBe(1)
    const [evidence] = await db.all<{ kind: string; refused: Uint8Array; existing: Uint8Array }>(
      'SELECT kind, refused, existing FROM conflict_evidence',
    )
    expect(evidence.kind).toBe('issue')
    expect(evidence.refused).toEqual(Uint8Array.of(12, 1))
    expect(evidence.existing).toEqual(Uint8Array.of(11, 1))
  })

  it('accepts issues of one lock whose intervals touch but do not overlap', async () => {
    await commitReceived(db, note({ amount: 5_000_000n, claims: [issueClaim(0n, 5_000_000n, 11)] }), LIMITS)
    const next = note({ amount: 5_000_000n, claims: [issueClaim(5_000_000n, 10_000_000n, 12)] })
    expect((await commitReceived(db, next, LIMITS)).status).toBe('accepted')
  })

  it('refuses a spend of an input already seen with another content', async () => {
    const spend = (content: number): Claim => ({
      kind: 'spend',
      input: id(77),
      content: id(content),
      wire: Uint8Array.of(content, 2),
    })
    await commitReceived(db, note({ amount: 1_000_000n, claims: [spend(1)] }), LIMITS)
    expect(await commitReceived(db, note({ amount: 1_000_000n, claims: [spend(2)] }), LIMITS)).toEqual({
      status: 'refused',
      reason: 'DoubleSpend',
    })
    expect((await db.all<{ kind: string }>('SELECT kind FROM conflict_evidence'))[0].kind).toBe('spend')
  })

  it('stores nothing when a statement fails half way', async () => {
    db = createNodeDb((sql, n) => sql.includes('INTO issue_claim') && n > 0)
    await migrate(db)
    await expect(
      commitReceived(db, note({ amount: 1_000_000n, claims: [issueClaim(0n, 1_000_000n, 11)] }), LIMITS),
    ).rejects.toThrow('injected failure')
    expect(await count('received_note')).toBe(0)
    expect(await count('note_liability')).toBe(0)
  })
})

describe('admit', () => {
  const candidate = { amount: 10n, liable: [{ device: ISSUER, lockSeq: 3, bond: 200n, attester: 1 }] }
  const snapshot = { conflicts: false, exposure: () => 0n }

  it('accepts what is within every limit', () => {
    expect(admit(candidate, snapshot, { maxPayment: 10n })).toEqual({ accept: true })
  })

  it('puts a double spend before every other reason', () => {
    expect(admit({ ...candidate, amount: 1_000n }, { ...snapshot, conflicts: true }, { maxPayment: 10n })).toEqual({
      accept: false,
      reason: 'DoubleSpend',
    })
  })

  it('refuses at exactly one unit over the capacity and accepts at the capacity', () => {
    expect(admit(candidate, { ...snapshot, exposure: () => 90n }, { maxPayment: 10n })).toEqual({
      accept: true,
    })
    expect(admit(candidate, { ...snapshot, exposure: () => 91n }, { maxPayment: 10n })).toEqual({
      accept: false,
      reason: 'OverLimit',
    })
  })
})

describe('settlement and identity', () => {
  const GRACE = 7 * 86400
  const body = (n: number) => new Uint8Array(82).fill(n)
  const wire = (n: number) => new Uint8Array(178).fill(n)
  const stateOf = async (outputId: Uint8Array) =>
    (await db.all<{ state: string }>('SELECT state FROM received_note WHERE output_id = ?', [outputId]))[0].state

  it('keeps the first settlement body, so a retry signs the same content', async () => {
    const held = note({ amount: 1_000_000n })
    await commitReceived(db, held, LIMITS)
    await prepareSettlement(db, held.outputId, body(1), 10)
    await prepareSettlement(db, held.outputId, body(2), 11)
    const [row] = await settleable(db, 12, GRACE)
    expect(row.settlementBody).toEqual(body(1))
    expect(row.settlementSpend).toBeNull()
  })

  it('marks a signed settlement as settling and keeps the first signed bytes', async () => {
    const held = note({ amount: 1_000_000n })
    await commitReceived(db, held, LIMITS)
    await prepareSettlement(db, held.outputId, body(1), 10)
    await markSettlementSigned(db, held.outputId, wire(1), 11)
    await markSettlementSigned(db, held.outputId, wire(2), 12)
    expect(await stateOf(held.outputId)).toBe('settling')
    expect((await settleable(db, 13, GRACE))[0].settlementSpend).toEqual(wire(1))
  })

  it('lists unsettled notes whose window is open, soonest expiry first, and no others', async () => {
    const late = note({ amount: 1n, expiry: 2_000_000_000 })
    const soon = note({ amount: 1n, expiry: 1_900_000_000 })
    const closed = note({ amount: 1n, expiry: 1_000 })
    const done = note({ amount: 1n, expiry: 1_950_000_000 })
    for (const n of [late, soon, closed, done]) await commitReceived(db, n, LIMITS)
    await setNoteState(db, done.outputId, 'settled', 5)
    const listed = await settleable(db, 1_800_000_000, GRACE)
    expect(listed.map((r) => r.expiry)).toEqual([1_900_000_000, 2_000_000_000])
    expect((await settleable(db, 1_000 + GRACE - 1, GRACE)).length).toBe(3)
    expect((await settleable(db, 1_000 + GRACE, GRACE)).length).toBe(2)
  })

  it("marks what an earlier identity held as lost and its unfinished payments as abandoned, and leaves the current key's", async () => {
    const mine = note({ amount: 1_000_000n, owner: ME })
    const old = note({ amount: 1_000_000n, owner: new Uint8Array(33).fill(8) })
    await commitReceived(db, mine, LIMITS)
    await commitReceived(db, old, LIMITS)
    await reconcileIdentity(db, ME, 20)
    await reconcileIdentity(db, ME, 21)
    expect(await stateOf(mine.outputId)).toBe('held')
    expect(await stateOf(old.outputId)).toBe('lost')
  })

  it('marks everything as lost when there is no current key at all', async () => {
    const mine = note({ amount: 1_000_000n, owner: ME })
    await commitReceived(db, mine, LIMITS)
    await reconcileIdentity(db, new Uint8Array(0), 30)
    expect(await stateOf(mine.outputId)).toBe('lost')
  })
})

describe('relianceByAttester', () => {
  it('adds up what unsettled notes rely on each attester, once per note', async () => {
    const second = { ...LOCK, device: id(2), attester: 7 }
    const third = { ...LOCK, device: id(3), attester: 8 }
    const first = note({ amount: 5_000_000n, liable: [LOCK, second, third] })
    await commitReceived(db, first, LIMITS)
    await commitReceived(db, note({ amount: 2_000_000n, liable: [LOCK] }), LIMITS)
    expect(await relianceByAttester(db)).toEqual({ '7': '7000000', '8': '5000000' })
  })

  it('stops counting a note when it settles, is spent, expires or is lost', async () => {
    const notes = [1_000_000n, 2_000_000n, 3_000_000n, 4_000_000n, 5_000_000n].map((amount) => note({ amount }))
    for (const n of notes) await commitReceived(db, n, LIMITS)
    await setNoteState(db, notes[0].outputId, 'settled', 1)
    await setNoteState(db, notes[1].outputId, 'spent', 1)
    await setNoteState(db, notes[2].outputId, 'expired', 1)
    await setNoteState(db, notes[3].outputId, 'lost', 1)
    expect(await relianceByAttester(db)).toEqual({ '7': '5000000' })
    await setNoteState(db, notes[4].outputId, 'settling', 2)
    expect(await relianceByAttester(db)).toEqual({ '7': '5000000' })
  })
})
