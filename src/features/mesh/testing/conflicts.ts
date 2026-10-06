import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  content,
  encodeIssueBody,
  encodeSpendConflict,
  envelope,
  interval,
  type Issue,
  type IssueClaim,
  type IssueConflict,
  issueSlot,
  recoveryId,
  type SpendConflict,
} from '../../../protocol'
import { MINT, NOTE_DOMAIN, NOW, type Party, party, signIssue, heldNote } from '../../../payment/testing/world'
import type { NoteDb } from '../../notes/db'
import { migrate } from '../../notes/schema'
import { createNodeDb } from '../../notes/testing/node-db'
import { seedHeld } from '../../notes/testing/seed'
import { acceptConflict, recordConflict } from '../gossip'

/** An in-memory note store with every migration applied. */
export async function openTestDb(): Promise<NoteDb> {
  const db = createNodeDb()
  await migrate(db)
  return db
}

export const noteDomain = NOTE_DOMAIN
export const otherDomain = NOTE_DOMAIN.map((byte) => byte ^ 1)

let counter = 0

const sha256Seed = (n: number, tag: number) => sha256(Uint8Array.of(n & 255, n >> 8, tag))

/** A new device key, distinct from the fixed parties of the payment tests. */
export function freshSigner(): Party {
  const secret = sha256Seed(++counter, 0xee)
  return { secret, key: p256.getPublicKey(secret, true) }
}

const sign = (signer: Party, message: Uint8Array) =>
  p256.sign(message, signer.secret, { prehash: true, lowS: true, format: 'compact' })

/** The same signature with `s` replaced by `n - s`: valid ECDSA that the protocol rejects. */
export function highS(signature: Uint8Array): Uint8Array {
  const s = BigInt(`0x${Buffer.from(signature.slice(32)).toString('hex')}`)
  const out = Uint8Array.from(signature)
  out.set(Buffer.from((p256.Point.Fn.ORDER - s).toString(16).padStart(64, '0'), 'hex'), 32)
  return out
}

/** Two contents for one output, both signed by `signer`, under `domain`. */
export function conflictFor(signer: Party, o: { domain?: Uint8Array } = {}): SpendConflict {
  const domain = o.domain ?? noteDomain
  const slot = sha256Seed(++counter, 0xaa)
  const contentA = sha256Seed(counter, 1)
  const contentB = sha256Seed(counter, 2)
  const a = envelope(domain, slot, contentA)
  const b = envelope(domain, slot, contentB)
  const signatureA = sign(signer, a)
  const signatureB = sign(signer, b)
  const recovery = recoveryId(signer.key, a, signatureA) | (recoveryId(signer.key, b, signatureB) << 2)
  return { slot, contentA, signatureA, contentB, signatureB, recovery }
}

/** Two issues from one lock signed by `signer`; they overlap unless `overlap` is false. */
export function issueConflictFor(signer: Party, o: { overlap?: boolean } = {}): IssueConflict {
  const base: Issue = {
    issuer: signer.key,
    mint: MINT,
    lockSeq: 1,
    cumEnd: 1_000_000n,
    salt: new Uint8Array(16),
    owner: { type: 'device', key: signer.key },
    amount: 1_000_000n,
    caveats: { expiry: NOW + 86_400, hopsLeft: 3, flags: 0, scopeKind: 0, scope: new Uint8Array(20) },
  }
  const other: Issue =
    o.overlap === false ? { ...base, cumEnd: 2_000_000n } : { ...base, owner: { type: 'device', key: party(5).key } }
  const claim = (issue: Issue): IssueClaim & { id: number } => {
    const signed = signIssue(signer, issue)
    const [start, end] = interval(signed.message)
    const body = content(encodeIssueBody(signed.message))
    const text = envelope(noteDomain, issueSlot(signed.message.lockSeq, start, end), body)
    return {
      lockSeq: signed.message.lockSeq,
      start,
      end,
      content: body,
      signature: signed.signature,
      id: recoveryId(signer.key, text, signed.signature),
    }
  }
  const { id: idA, ...a } = claim(base)
  const { id: idB, ...b } = claim(other)
  return { a, b, recovery: idA | (idB << 2) }
}

/** A held note issued by `signer` to a fixed receiver; with `flag`, a conflict of `signer` is already flagged. */
export async function holdChainSignedBy(db: NoteDb, signer: Party, o: { flag?: boolean } = {}) {
  const me = party(9)
  const note = heldNote({ from: signer, to: me, amount: 1_000_000n })
  await seedHeld(db, { outputId: note.outputId, owner: me.key, note })
  if (o.flag) {
    const wire = encodeSpendConflict(conflictFor(signer))
    const accepted = acceptConflict(noteDomain, 'spend', wire)
    if (!accepted.ok) throw new Error('fixture')
    await recordConflict(db, { ...accepted, known: true }, wire, 'mesh', 1)
  }
  return note
}
