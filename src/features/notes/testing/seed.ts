import { encodeBundle } from '../../../payment/messages'
import type { HeldOutput } from '../../../payment/respend'
import { heldNote, party } from '../../../payment/testing/world'
import { encodeCaveats } from '../../../protocol'
import type { NoteDb } from '../db'
import { migrate } from '../schema'

/** Inserts a held note for `owner` whose bundle is a real chain, so that the store can decode it. */
export async function seedHeld(
  db: NoteDb,
  o: { outputId: Uint8Array; owner: Uint8Array; amount?: bigint; note?: HeldOutput },
) {
  await migrate(db)
  const note = o.note ?? heldNote({ from: party(1), to: party(2), amount: o.amount ?? 1_000_000n })
  const { issue } = note.bundle
  await db.run(
    `INSERT INTO received_note (output_id, message_id, owner, mint, amount, expiry, hops_left, caveats, issuer, lock_seq, bundle, state,
       transport, received_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', 'qr', 1, 1)`,
    [
      o.outputId,
      o.outputId.map((b) => b ^ 0xff),
      o.owner,
      issue.message.mint,
      Number(note.output.amount),
      note.output.caveats.expiry,
      note.output.caveats.hopsLeft,
      encodeCaveats(note.output.caveats),
      issue.message.issuer,
      issue.message.lockSeq,
      encodeBundle(note.bundle),
    ],
  )
}
