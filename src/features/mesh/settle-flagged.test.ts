import { describe, expect, it, vi } from 'vitest'
import { freshSigner, holdChainSignedBy, openTestDb } from './testing/conflicts'
import type { HeldNote } from './gossip'
import { settleFlagged } from './settle-flagged'

describe('settle now', () => {
  it('settles each held note with a flagged signer once, and none without', async () => {
    const db = await openTestDb()
    const flagged = await holdChainSignedBy(db, freshSigner(), { flag: true })
    await holdChainSignedBy(db, freshSigner())
    const settle = vi.fn(async (_note: HeldNote) => {})
    await Promise.all([settleFlagged(db, settle), settleFlagged(db, settle)])
    expect(settle).toHaveBeenCalledOnce()
    expect(settle.mock.calls[0][0].outputId).toEqual(flagged.outputId)
  })

  it('tries again after a failure', async () => {
    const db = await openTestDb()
    await holdChainSignedBy(db, freshSigner(), { flag: true })
    const settle = vi.fn(async (_note: HeldNote) => {
      throw new Error('offline')
    })
    await settleFlagged(db, settle)
    await settleFlagged(db, settle)
    expect(settle).toHaveBeenCalledTimes(2)
  })
})
