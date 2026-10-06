import { describe, expect, it } from 'vitest'
import { passedThrough } from '../../payment/testing/chain'
import { party } from '../../payment/testing/world'
import { encodeBundle } from '../../payment/messages'
import { chainKeys, isKnownKey } from './known-keys'
import { freshSigner, holdChainSignedBy, openTestDb } from './testing/conflicts'

describe('known keys', () => {
  it('lists the issuer and every holder of a chain', () => {
    const [issuer, a, b] = [freshSigner(), freshSigner(), freshSigner()]
    const keys = chainKeys({ ...passedThrough(issuer, [a, b]), tickets: [] })
    expect(keys).toContainEqual(issuer.key)
    expect(keys).toContainEqual(a.key)
    expect(keys).toContainEqual(b.key)
  })

  it('knows the issuer of a stored note and a key that only held it on the way', async () => {
    const db = await openTestDb()
    const issuer = freshSigner()
    await holdChainSignedBy(db, issuer)
    expect(await isKnownKey(db, issuer.key)).toBe(true)

    const holder = freshSigner()
    const chain = { ...passedThrough(freshSigner(), [holder, party(8)]), tickets: [] }
    await db.run(
      `INSERT INTO received_note (output_id, message_id, owner, mint, amount, expiry, hops_left, caveats, issuer, lock_seq, bundle, state,
         transport, received_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, 1, ?, ?, 1, ?, 'spent', 'qr', 1, 1)`,
      [
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
        party(8).key,
        chain.issue.message.mint,
        new Uint8Array(1),
        chain.issue.message.issuer,
        encodeBundle(chain),
      ],
    )
    expect(await isKnownKey(db, holder.key)).toBe(true)
    expect(await isKnownKey(db, freshSigner().key)).toBe(false)
  })

  it('knows the device of a ticket it relied on', async () => {
    const db = await openTestDb()
    const device = freshSigner()
    await holdChainSignedBy(db, freshSigner())
    await db.run('INSERT INTO lock_cursor (device, lock_seq, next_cum_end) VALUES (?, 1, 0)', [device.key])
    expect(await isKnownKey(db, device.key)).toBe(true)
  })
})
