import { describe, expect, it } from 'vitest'
import { encodeIssueConflict, encodeSpendConflict, type IssueConflict, type SpendConflict } from '../../protocol'
import { TICKET_DOMAIN } from '../../payment/testing/world'
import { acceptConflict } from './gossip'
import { conflictFor, freshSigner, highS, issueConflictFor, noteDomain, otherDomain } from './testing/conflicts'

describe('accepting a conflict proof', () => {
  it('recovers the culprit of a spend conflict and of an issue conflict', () => {
    const s = freshSigner()
    const a = acceptConflict(noteDomain, 'spend', encodeSpendConflict(conflictFor(s)))
    expect(a.ok && a.key).toEqual(s.key)
    const b = acceptConflict(noteDomain, 'issue', encodeIssueConflict(issueConflictFor(s)))
    expect(b.ok && b.key).toEqual(s.key)
  })

  it.each([
    ['equal content', (c: SpendConflict) => ({ ...c, contentB: c.contentA, signatureB: c.signatureA })],
    ['a high-S signature', (c: SpendConflict) => ({ ...c, signatureB: highS(c.signatureB) })],
    ['flipped recovery bits', (c: SpendConflict) => ({ ...c, recovery: c.recovery ^ 0b11 })],
    [
      'two different signers',
      (c: SpendConflict) => {
        const other = conflictFor(freshSigner())
        return { ...c, contentB: other.contentB, signatureB: other.signatureB }
      },
    ],
  ])('drops a spend conflict with %s', (_, mutate) => {
    const wire = encodeSpendConflict(mutate(conflictFor(freshSigner())))
    expect(acceptConflict(noteDomain, 'spend', wire).ok).toBe(false)
  })

  it('names why a proof was dropped', () => {
    const c = conflictFor(freshSigner())
    const other = conflictFor(freshSigner())
    const wire = (x: SpendConflict) => encodeSpendConflict(x)
    expect(acceptConflict(noteDomain, 'spend', new Uint8Array(3))).toEqual({ ok: false, reason: 'Malformed' })
    expect(acceptConflict(noteDomain, 'spend', wire({ ...c, signatureB: other.signatureB }))).toEqual({
      ok: false,
      reason: 'NoSigner',
    })
    const disjoint = encodeIssueConflict(issueConflictFor(freshSigner(), { overlap: false }))
    expect(acceptConflict(noteDomain, 'issue', disjoint)).toEqual({ ok: false, reason: 'Invalid' })
  })

  it('drops a proof signed under another domain or another purpose', () => {
    const s = freshSigner()
    expect(acceptConflict(otherDomain, 'spend', encodeSpendConflict(conflictFor(s))).ok).toBe(false)
    expect(acceptConflict(noteDomain, 'spend', encodeSpendConflict(conflictFor(s, { domain: TICKET_DOMAIN }))).ok).toBe(
      false,
    )
  })

  it('drops issue conflicts whose intervals do not overlap', () => {
    const c: IssueConflict = issueConflictFor(freshSigner(), { overlap: false })
    expect(acceptConflict(noteDomain, 'issue', encodeIssueConflict(c)).ok).toBe(false)
  })

  it('drops truncated or padded wires and a wire of the other kind', () => {
    const s = freshSigner()
    const wire = encodeSpendConflict(conflictFor(s))
    expect(acceptConflict(noteDomain, 'spend', wire.slice(0, 226)).ok).toBe(false)
    expect(acceptConflict(noteDomain, 'spend', Uint8Array.of(...wire, 0)).ok).toBe(false)
    expect(acceptConflict(noteDomain, 'issue', wire).ok).toBe(false)
  })

  it('identifies a proof by the SHA-256 of its bytes', () => {
    const wire = encodeSpendConflict(conflictFor(freshSigner()))
    const a = acceptConflict(noteDomain, 'spend', wire)
    expect(a.ok && a.id).toHaveLength(32)
  })
})
