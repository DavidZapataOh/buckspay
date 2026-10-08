import { bytesToHex } from '@noble/hashes/utils.js'
import { describe, expect, it } from 'vitest'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import {
  claimDelay,
  innerMaker,
  leafRecords,
  loadLeafSecrets,
  locateLeaves,
  makeLeafSecret,
  scheduleClaims,
} from './secrets'
import { BN254_R, fromCanonical, poseidon2, toBytes32 } from './secrets-poseidon'
import { DEBTS_SCHEMA_VERSION } from '../debts/store'
import { leafOf } from './secrets-tree'

const store = async () => {
  const db = createNodeDb()
  await migrate(db)
  return db
}

const fixed = (...values: number[]) => {
  let at = 0
  return (n: number) => Uint8Array.from({ length: n }, () => values[at++ % values.length])
}

describe('leaf secrets', () => {
  it('makes nonzero secrets below the field order and an inner that is their Poseidon hash', async () => {
    const db = await store()
    const s = await makeLeafSecret(db, 3, 100)
    const n = fromCanonical(s.nullifier, 'nullifier')
    const t = fromCanonical(s.trapdoor, 'trapdoor')
    expect(n > 0n && n < BN254_R && t > 0n && t < BN254_R).toBe(true)
    expect(s.nullifier[0]).toBe(0)
    expect(s.inner).toEqual(toBytes32(poseidon2(n, t)))
    expect(s.leaf).toEqual(leafOf(s.inner, 3))
    const [stored] = await loadLeafSecrets(db)
    expect(stored).toMatchObject({ exp: 3, state: 'made', epoch: null, leafIndex: null, createdAt: 100 })
    expect(stored.nullifier).toEqual(s.nullifier)
  })

  it('draws again when the random bytes are all zero', async () => {
    const db = await store()
    const draws: number[] = []
    const random = (n: number) => {
      draws.push(n)
      return new Uint8Array(n).fill(draws.length <= 2 ? 0 : 7)
    }
    const s = await makeLeafSecret(db, 1, 0, random)
    expect(draws.length).toBeGreaterThan(2)
    expect(s.nullifier.some((b) => b !== 0)).toBe(true)
  })

  it('refuses an exponent outside 1 to 7, and two secrets are never the same leaf', async () => {
    const db = await store()
    for (const exp of [0, 8, -1, 1.5]) await expect(makeLeafSecret(db, exp, 0)).rejects.toThrow('exponent')
    const a = await makeLeafSecret(db, 2, 0)
    const b = await makeLeafSecret(db, 2, 0)
    expect(bytesToHex(a.leaf)).not.toBe(bytesToHex(b.leaf))
    await expect(makeLeafSecret(db, 2, 0, fixed(1, 2, 3))).resolves.toBeDefined()
    await expect(makeLeafSecret(db, 2, 0, fixed(1, 2, 3))).rejects.toThrow()
  })

  it('stores the secrets before the inner is handed out', async () => {
    const db = await store()
    const inner = await innerMaker(db, () => 5)(4)
    const [stored] = await loadLeafSecrets(db)
    expect(stored.inner).toEqual(inner)
    expect(stored.exp).toBe(4)
  })

  it('is part of the note store at its newest version', async () => {
    const db = await store()
    expect((await db.all<{ user_version: number }>('PRAGMA user_version'))[0].user_version).toBe(DEBTS_SCHEMA_VERSION)
    await migrate(db)
    await expect(
      db.run(
        "INSERT INTO leaf_secrets (leaf, nullifier, trapdoor, inner, exp, state, created_at) VALUES (x'00', x'00', x'00', x'00', 1, 'made', 0)",
      ),
    ).rejects.toThrow()
  })
})

describe('claim timing', () => {
  it('draws a delay of one to twenty-four hours and covers both ends', () => {
    expect(claimDelay(() => Uint8Array.of(0, 0, 0, 0))).toBe(3_600)
    const last = 82_800
    expect(claimDelay(() => Uint8Array.of(0, last >> 16, (last >> 8) & 255, last & 255))).toBe(86_400)
    for (let i = 0; i < 200; i++) {
      const d = claimDelay()
      expect(d >= 3_600 && d <= 86_400).toBe(true)
    }
  })

  it('discards a draw from the biased tail instead of folding it', () => {
    const draws = [Uint8Array.of(255, 255, 255, 255), Uint8Array.of(0, 0, 0, 5)]
    expect(claimDelay(() => draws.shift()!)).toBe(3_600 + 5)
  })

  it('finds a leaf in the tree and leaves it unscheduled, the others made', async () => {
    const db = await store()
    const mine = await makeLeafSecret(db, 2, 0)
    await makeLeafSecret(db, 3, 0)
    const others = [new Uint8Array(32).fill(1), mine.leaf, new Uint8Array(32).fill(2)]
    expect(await locateLeaves(db, 4, others)).toBe(1)
    expect((await loadLeafSecrets(db, ['in_tree']))[0]).toMatchObject({ epoch: 4, leafIndex: 1, claimAt: null })
    expect(await loadLeafSecrets(db, ['made'])).toHaveLength(1)
    expect(await locateLeaves(db, 4, others)).toBe(0)
  })

  it('schedules the claim a random while from now, or at once when asked, and only once', async () => {
    const db = await store()
    const a = await makeLeafSecret(db, 2, 0)
    const b = await makeLeafSecret(db, 3, 0)
    await locateLeaves(db, 0, [a.leaf, b.leaf])
    expect(await scheduleClaims(db, 1_000, { immediate: false }, () => Uint8Array.of(0, 0, 0, 9))).toBe(2)
    expect((await loadLeafSecrets(db)).map((s) => s.claimAt)).toEqual([1_000 + 3_600 + 9, 1_000 + 3_600 + 9])
    expect(await scheduleClaims(db, 5_000, { immediate: true })).toBe(0)
    await db.run('UPDATE leaf_secrets SET claim_at = NULL WHERE leaf = ?', [a.leaf])
    expect(await scheduleClaims(db, 5_000, { immediate: true })).toBe(1)
    expect((await loadLeafSecrets(db)).find((s) => s.exp === 2)?.claimAt).toBe(5_000)
  })

  it('schedules a failed claim again from the start', async () => {
    const db = await store()
    const s = await makeLeafSecret(db, 2, 0)
    await locateLeaves(db, 0, [s.leaf])
    await db.run("UPDATE leaf_secrets SET state = 'failed', error = 'x', job_key = 'k', claim_at = 5")
    expect(await scheduleClaims(db, 60, { immediate: true })).toBe(1)
    expect((await loadLeafSecrets(db))[0]).toMatchObject({ state: 'in_tree', claimAt: 60, error: null, jobKey: null })
  })

  it('shows a leaf to the rewards screen only once the tree holds it', async () => {
    const db = await store()
    const a = await makeLeafSecret(db, 2, 0)
    await makeLeafSecret(db, 3, 0)
    expect(await leafRecords(db, 490_000n)).toEqual([])
    await locateLeaves(db, 0, [a.leaf])
    expect(await leafRecords(db, 490_000n)).toEqual([{ kind: 'leaf', state: 'unclaimed', exp: 2, unit: 490_000n }])
    await db.run("UPDATE leaf_secrets SET state = 'proving'")
    expect((await leafRecords(db, 1n))[0].state).toBe('claiming')
    await db.run("UPDATE leaf_secrets SET state = 'submitted'")
    expect((await leafRecords(db, 1n))[0].state).toBe('claiming')
    await db.run("UPDATE leaf_secrets SET state = 'claimed', signature = 'sig'")
    expect((await leafRecords(db, 1n))[0]).toMatchObject({ state: 'claimed', signature: 'sig' })
    await db.run("UPDATE leaf_secrets SET state = 'failed', signature = NULL")
    expect((await leafRecords(db, 1n))[0].state).toBe('unclaimed')
  })
})
