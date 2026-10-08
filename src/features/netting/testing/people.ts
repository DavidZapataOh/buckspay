import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes } from '@noble/hashes/utils.js'
import {
  content,
  decodeIou,
  envelope,
  iouEnvelope,
  joinSlot,
  Kind,
  type NettingJoin,
  encodeJoin,
} from '../../../protocol'
import { migrate } from '../../notes/schema'
import type { NoteDb } from '../../notes/db'
import { createNodeDb } from '../../notes/testing/node-db'
import { openTab, saveCoSigned } from '../../debts/store'
import { coSigned, contentOf, IOU_DOMAIN, iouOf, MINT, type Party, party } from '../../debts/testing'
import type { SignedJoin } from '../messages'

export const NOW = 1_800_000_000

/** A phone in a test: real P-256 device key, real Ed25519 ephemeral key, a real note store at the current version. */
export type Person = {
  index: number
  letter: string
  party: Party
  db: NoteDb
  ephemeralSecret: Uint8Array
  ephemeral: Uint8Array
  /** `signIou` of this phone: what it signed, by kind. */
  signIou(body: Uint8Array): Promise<Uint8Array>
  signLog(): string[]
  signedJoin(session: Uint8Array): SignedJoin
}

export async function person(
  index: number,
  options: { dbFailOn?: (sql: string, count: number) => boolean } = {},
): Promise<Person> {
  const device = party(0xa1 + index)
  const db = createNodeDb(options.dbFailOn)
  await migrate(db)
  const ephemeralSecret = new Uint8Array(32).fill(0x40 + index)
  const log: string[] = []
  const signedJoin = (session: Uint8Array): SignedJoin => {
    const join: NettingJoin = { session, ephemeral: ed25519.getPublicKey(ephemeralSecret), key: device.key }
    const body = encodeJoin(join)
    return { body, signature: device.sign(envelope(IOU_DOMAIN, joinSlot(session), content(body))) }
  }
  return {
    index,
    letter: String.fromCharCode(65 + index),
    party: device,
    db,
    ephemeralSecret,
    ephemeral: ed25519.getPublicKey(ephemeralSecret),
    async signIou(body) {
      if (body[1] === Kind.NettingJoin) {
        log.push('join')
        return signedJoin(new Uint8Array(body.subarray(2, 34))).signature
      }
      log.push('state')
      return device.sign(iouEnvelope(decodeIou(body), IOU_DOMAIN))
    },
    signLog: () => log,
    signedJoin,
  }
}

export const tabIdOf = (a: Person, b: Person) =>
  sha256(concatBytes(...[a.party.key, b.party.key].sort((x, y) => Buffer.compare(x, y)), MINT))

export const tabSecretOf = (tab: Uint8Array) => sha256(concatBytes(tab, Uint8Array.of(1)))

export type TabOptions = { amount: bigint; debtor: Person; creditor: Person; due?: number; extraOnA?: bigint }

/** One tab between two phones, with the same co-signed first change in both stores; `extraOnA` is a second Open only `a` holds. */
export async function openTabBetween(a: Person, b: Person, o: TabOptions): Promise<Uint8Array> {
  const tab = tabIdOf(a, b)
  const secret = tabSecretOf(tab)
  for (const [me, peer] of [
    [a, b],
    [b, a],
  ] as const) {
    await openTab(me.db, { tab, secret, peer: peer.party.key, mint: MINT }, NOW)
  }
  const first = coSigned(
    iouOf(1, o.debtor.party.key, o.creditor.party.key, o.amount, { tab, due: o.due ?? 0 }),
    o.debtor.party,
    o.creditor.party,
  )
  for (const p of [a, b]) await saveCoSigned(p.db, first, NOW)
  if (o.extraOnA) {
    const reference = contentOf(first)
    const second = coSigned(
      iouOf(2, o.debtor.party.key, o.creditor.party.key, o.extraOnA, { tab, reference }),
      o.debtor.party,
      o.creditor.party,
    )
    await saveCoSigned(a.db, second, NOW)
  }
  return tab
}

/** Marks a tab as holding an agreed netting, as a phone that approved it would. */
export async function markPending(p: Person, tab: Uint8Array, seq: number) {
  const session = sha256(concatBytes(tab, Uint8Array.of(0x99)))
  await p.db.run(
    'INSERT INTO netting_sessions (session, role, my_index, status, created_at, updated_at) VALUES (?, 1, ?, 3, ?, ?)',
    [session, p.index, NOW, NOW],
  )
  await p.db.run('INSERT INTO netting_effects (session, tab, base_seq, debtor, cancel) VALUES (?, ?, ?, ?, 1)', [
    session,
    tab,
    seq,
    p.party.key,
  ])
}
