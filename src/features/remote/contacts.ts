import type { GetAccountInfoApi, Rpc } from '@solana/kit'
import type { NoteDb } from '../notes/db'
import type { PayLink } from './pay-link'
import { type ContactCheck, tokenAccountExists } from './token-account'

export type Contact = PayLink & { check: ContactCheck }

/** Saves the link as a contact. Online, the friend's token account is read first; offline or on a failed read the contact is marked not checked. */
export async function saveContact(
  db: NoteDb,
  link: PayLink,
  now: number,
  rpc: Rpc<GetAccountInfoApi> | null,
): Promise<ContactCheck> {
  let check: ContactCheck = 'not-checked'
  if (rpc) {
    check = await tokenAccountExists(rpc, link.wallet, link.mint).then(
      (exists) => (exists ? 'verified' : 'no-account'),
      () => 'not-checked' as const,
    )
  }
  await db.run(
    `INSERT INTO contacts (wallet, mint, name, added_at, "check", checked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (wallet) DO UPDATE SET mint = excluded.mint, name = excluded.name, "check" = excluded."check", checked_at = excluded.checked_at`,
    [link.wallet, link.mint, link.name, now, check, check === 'not-checked' ? null : now],
  )
  return check
}

export async function listContacts(db: NoteDb): Promise<Contact[]> {
  const rows = await db.all<{ wallet: Uint8Array; mint: Uint8Array; name: string; check: ContactCheck }>(
    'SELECT wallet, mint, name, "check" FROM contacts ORDER BY name',
  )
  return rows.map((row) => ({ wallet: row.wallet, mint: row.mint, name: row.name, check: row.check }))
}
