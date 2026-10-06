import { describe, expect, it, vi } from 'vitest'
import type { Issue } from '../protocol'
import { PayError } from './pay'
import { signStoredIssue } from './native-sign'
import { MINT, party } from './testing/world'

const signIssue = vi.fn()
vi.mock('../keys', () => ({ signIssue: (issue: Issue) => signIssue(issue) }))

const issue: Issue = {
  issuer: party(1).key,
  mint: MINT,
  lockSeq: 3,
  cumEnd: 5n,
  salt: new Uint8Array(16).fill(1),
  owner: { type: 'device', key: party(2).key },
  amount: 5n,
  caveats: { expiry: 2_000_000_000, hopsLeft: 3, flags: 0, scopeKind: 0, scope: new Uint8Array(20) },
}

describe('signStoredIssue', () => {
  it('returns the signature of the issue it was given', async () => {
    const signature = new Uint8Array(64).fill(7)
    signIssue.mockResolvedValueOnce({ message: issue, signature })
    expect(await signStoredIssue(issue)).toEqual(signature)
  })

  it('refuses a signature over another issue than the stored one: the receipt could not name it', async () => {
    signIssue.mockResolvedValueOnce({
      message: { ...issue, salt: new Uint8Array(16).fill(2) },
      signature: new Uint8Array(64),
    })
    const failure = await signStoredIssue(issue).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PayError)
    expect(failure).toMatchObject({ code: 'Mismatch' })
  })

  it('lets the native failure through, whatever it says', async () => {
    const locked = Object.assign(new Error('locked'), { code: 'ERR_DEVICE_LOCKED' })
    signIssue.mockRejectedValueOnce(locked)
    await expect(signStoredIssue(issue)).rejects.toBe(locked)
  })
})
