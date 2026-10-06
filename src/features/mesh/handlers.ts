import { equalBytes } from '@noble/curves/utils.js'
import type { NoteDb } from '../notes/db'
import { type Accepted, acceptConflict, GOSSIP_SLOTS, GOSSIP_TTL, recordConflict, toAdvertise } from './gossip'
import { encodeFrame } from './frame'
import { isKnownKey } from './known-keys'

type Advertise = (frameId: string, frame: Uint8Array, ttlSeconds: number) => Promise<void>

/** Puts a proof on the air if it is among the few the pool lets through right now. */
export async function passOn(db: NoteDb, wire: Uint8Array, now: number, advertise: Advertise): Promise<void> {
  const onAir = (await toAdvertise(db, now, GOSSIP_SLOTS)).find(({ frame }) => equalBytes(frame.payload, wire))
  if (onAir) await advertise(onAir.id, encodeFrame(onAir.frame), GOSSIP_TTL)
}

export type ConflictHandlerDeps = {
  db: NoteDb
  domain: Uint8Array
  advertise: Advertise
  /** Called after a key this phone knows was flagged. */
  onFlag: () => Promise<void>
  now: () => number
}

/** The handlers of the conflict frames the mesh task receives: verify, keep, and pass on what was new and fits the air. */
export function conflictHandlers({ db, domain, advertise, onFlag, now }: ConflictHandlerDeps) {
  const handle = (kind: 'spend' | 'issue') => async (wire: Uint8Array) => {
    const accepted = acceptConflict(domain, kind, wire)
    if (!accepted.ok) return
    const verified: Extract<Accepted, { ok: true }> = { ...accepted, known: await isKnownKey(db, accepted.key) }
    const seenAt = now()
    const outcome = await recordConflict(db, verified, wire, 'mesh', seenAt)
    if (outcome === 'duplicate') return
    await passOn(db, wire, seenAt, advertise)
    if (outcome === 'flagged') await onFlag()
  }
  return { spend: handle('spend'), issue: handle('issue') }
}
