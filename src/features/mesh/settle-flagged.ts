import type { NoteDb } from '../notes/db'
import { type HeldNote, heldWithFlagged } from './gossip'

let settler: ((note: HeldNote) => Promise<void>) | undefined

/** The app's settlement runner, for as long as it is mounted; returns what removes it. */
export function registerSettler(settle: (note: HeldNote) => Promise<void>): () => void {
  settler = settle
  return () => {
    if (settler === settle) settler = undefined
  }
}

/** Settles the flagged held notes through the registered runner; without one the app settles them when it opens. */
export const settleNow = (db: NoteDb) => settleFlagged(db, async (note) => settler?.(note))

let running: Promise<void> | undefined

/** Settles each held note whose chain has a flagged key, before the culprit's other branch lands; calls overlap into one run and a failed note is tried again on the next. */
export function settleFlagged(db: NoteDb, settle: (note: HeldNote) => Promise<void>): Promise<void> {
  running ??= (async () => {
    try {
      for (const note of await heldWithFlagged(db)) await settle(note).catch(() => undefined)
    } finally {
      running = undefined
    }
  })()
  return running
}
