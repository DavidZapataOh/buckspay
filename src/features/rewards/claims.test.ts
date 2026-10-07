import { describe, expect, it, vi } from 'vitest'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { createRewardClaims } from './claims'
import { CLAIM_DELAY_MAX, CLAIM_DELAY_MIN, loadLeafSecrets, makeLeafSecret } from './secrets'
import type { ClaimProgress } from './secrets-claim'

const IDLE: ClaimProgress = { enqueued: 0, submitted: 0, claimed: 0, failed: 0, waiting: 0 }
const NOW = 1_800_000_000

async function setup(states: string[] = ['in_tree']) {
  const db = createNodeDb()
  await migrate(db)
  for (const state of states) {
    const secret = await makeLeafSecret(db, 1, NOW)
    await db.run('UPDATE leaf_secrets SET state = ?, epoch = 0, leaf_index = 0 WHERE leaf = ?', [state, secret.leaf])
  }
  const advance = vi.fn(async () => IDLE)
  const unit = vi.fn(async () => 490_000n)
  const move = vi.fn(async () => {})
  const claims = createRewardClaims({ db, route: { advance }, unit, move, now: () => NOW })
  return { db, advance, unit, move, claims }
}

describe('reward claims', () => {
  it('lists nothing without reading the chain when the phone holds no leaves', async () => {
    const { claims, unit } = await setup([])
    expect(await claims.leaves()).toEqual([])
    expect(unit).not.toHaveBeenCalled()
  })

  it('lists the leaves with the unit it was given, which is the cached one offline', async () => {
    const { claims } = await setup(['in_tree', 'claimed'])
    const records = await claims.leaves()
    expect(records.map(({ state }) => state).sort()).toEqual(['claimed', 'unclaimed'])
    expect(records.every((record) => record.kind === 'leaf' && record.unit === 490_000n)).toBe(true)
  })

  it('claims by default at a random time between one and twenty-four hours, after locating the new leaves', async () => {
    const { claims, advance, db } = await setup()
    await claims.claim({ immediate: false })
    const [leaf] = await loadLeafSecrets(db)
    expect(leaf.claimAt).toBeGreaterThanOrEqual(NOW + CLAIM_DELAY_MIN)
    expect(leaf.claimAt).toBeLessThanOrEqual(NOW + CLAIM_DELAY_MAX)
    expect(advance).toHaveBeenCalledTimes(2)
  })

  it('claims at once only when asked to', async () => {
    const { claims, db } = await setup()
    await claims.claim({ immediate: true })
    expect((await loadLeafSecrets(db))[0].claimAt).toBe(NOW)
  })

  it('tells the person why a claim failed and keeps it on the leaf', async () => {
    const { claims, db, advance } = await setup()
    advance.mockImplementation(async () => {
      await db.run('UPDATE leaf_secrets SET state = ?, error = ? WHERE state = ?', [
        'failed',
        'The gateway is not accepting claims right now.',
        'in_tree',
      ])
      return { ...IDLE, failed: 1 }
    })
    advance.mockResolvedValueOnce(IDLE)
    await expect(claims.claim({ immediate: true })).rejects.toThrow('The gateway is not accepting claims right now.')
    expect((await loadLeafSecrets(db, ['failed']))[0].error).toBe('The gateway is not accepting claims right now.')
  })

  it('lets a failure of the route reach the screen, with the schedule already stored', async () => {
    const { claims, db, advance } = await setup()
    advance.mockResolvedValueOnce(IDLE).mockRejectedValueOnce(new Error('Network request failed'))
    await expect(claims.claim({ immediate: false })).rejects.toThrow('Network request failed')
    expect((await loadLeafSecrets(db))[0].claimAt).not.toBeNull()
  })

  it('moves through the sweep it was given', async () => {
    const { claims, move } = await setup()
    await claims.move()
    expect(move).toHaveBeenCalledOnce()
  })
})
