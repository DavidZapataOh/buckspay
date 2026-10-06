import { describe, expect, it, vi } from 'vitest'
import { encodeIssueConflict, encodeSpendConflict } from '../../protocol'
import { acceptConflict, isFlagged, recordConflict } from './gossip'
import { conflictHandlers } from './handlers'
import {
  conflictFor,
  freshSigner,
  holdChainSignedBy,
  issueConflictFor,
  noteDomain,
  openTestDb,
} from './testing/conflicts'
import { FrameKind } from './frame'

const setup = async () => {
  const db = await openTestDb()
  const advertise = vi.fn(async (_id: string, _frame: Uint8Array, _ttl: number) => {})
  const onFlag = vi.fn(async () => {})
  return { db, advertise, onFlag, h: conflictHandlers({ db, domain: noteDomain, advertise, onFlag, now: () => 1 }) }
}

describe('conflict handlers', () => {
  it('re-advertises a verified proof and ignores an invalid one', async () => {
    const { h, advertise } = await setup()
    await h.spend(encodeSpendConflict(conflictFor(freshSigner())))
    await h.spend(new Uint8Array(227))
    expect(advertise).toHaveBeenCalledOnce()
    const [, frame, ttl] = advertise.mock.calls[0]
    expect(frame[0]).toBe(FrameKind.SpendConflict)
    expect(ttl).toBe(30 * 60)
  })

  it('does not put a proof on the air when four others have the slots', async () => {
    const { h, db, advertise } = await setup()
    for (let i = 0; i < 4; i++) {
      const wire = encodeSpendConflict(conflictFor(freshSigner()))
      const a = acceptConflict(noteDomain, 'spend', wire)
      if (a.ok) await recordConflict(db, a, wire, 'mesh', 100)
    }
    await h.spend(encodeSpendConflict(conflictFor(freshSigner())))
    expect(advertise).not.toHaveBeenCalled()
  })

  it('does not advertise a proof it already has', async () => {
    const { h, advertise } = await setup()
    const wire = encodeSpendConflict(conflictFor(freshSigner()))
    await h.spend(wire)
    await h.spend(wire)
    expect(advertise).toHaveBeenCalledOnce()
  })

  it('flags a culprit this phone knows, passes the proof on and tells the settler', async () => {
    const { h, db, advertise, onFlag } = await setup()
    const s = freshSigner()
    await holdChainSignedBy(db, s)
    await h.issue(encodeIssueConflict(issueConflictFor(s)))
    expect(await isFlagged(db, s.key)).toBe(true)
    expect(advertise).toHaveBeenCalledOnce()
    expect(onFlag).toHaveBeenCalledOnce()
  })

  it('only pools the proof of a culprit it has not met', async () => {
    const { h, db, onFlag } = await setup()
    const s = freshSigner()
    await h.spend(encodeSpendConflict(conflictFor(s)))
    expect(await isFlagged(db, s.key)).toBe(false)
    expect(onFlag).not.toHaveBeenCalled()
  })
})
