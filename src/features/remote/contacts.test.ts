import { describe, expect, it } from 'vitest'
import { migrate } from '../notes/schema'
import { createNodeDb } from '../notes/testing/node-db'
import { listContacts, saveContact } from './contacts'
import { fakeAccountRpc, link } from './testing'

describe('contacts and the friend’s token account', () => {
  it('saving online re-checks the token account; offline marks it not checked', async () => {
    const db = createNodeDb()
    await migrate(db)
    await saveContact(db, link, 1, fakeAccountRpc({ exists: false }))
    expect(await db.all('SELECT "check" FROM contacts')).toEqual([{ check: 'no-account' }])
    await saveContact(db, { ...link, wallet: new Uint8Array(32).fill(6) }, 1, null)
    expect((await db.all('SELECT "check" FROM contacts')).map((r) => r.check)).toContain('not-checked')
    await saveContact(db, link, 2, fakeAccountRpc({ exists: true }))
    expect((await listContacts(db)).find((c) => c.name === 'Ana')?.check).toBe('verified')
  })
  it('a failed read leaves the contact unchecked instead of failing', async () => {
    const db = createNodeDb()
    await migrate(db)
    await saveContact(db, link, 1, fakeAccountRpc({ exists: true, fails: true }))
    expect((await listContacts(db))[0].check).toBe('not-checked')
  })
})
