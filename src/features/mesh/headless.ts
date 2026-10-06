import { deviceKeyCluster } from '../../keys'
import { paymentDomains } from '../../payment/domains'
import type { NoteDb } from '../notes/db'
import { openNoteDb } from '../notes/key'
import { FrameKind } from './frame'
import { conflictHandlers } from './handlers'
import { meshNative } from './native'
import { settleNow } from './settle-flagged'
import type { MeshHandlers } from './task'

let store: Promise<NoteDb> | undefined

/** The handlers of the headless task. A frame that arrives before the app configured its cluster is dropped, as before. */
export function meshHandlers(): MeshHandlers {
  const conflicts = async (kind: 'spend' | 'issue', wire: Uint8Array) => {
    const cluster = deviceKeyCluster()
    if (!cluster) return
    const db = await (store ??= openNoteDb())
    const handlers = conflictHandlers({
      db,
      domain: paymentDomains(cluster).noteDomain,
      advertise: (id, frame, ttl) => meshNative.advertise(id, frame, ttl),
      onFlag: () => settleNow(db),
      now: () => Math.floor(Date.now() / 1000),
    })
    await handlers[kind](wire)
  }
  return {
    [FrameKind.SpendConflict]: (wire) => conflicts('spend', wire),
    [FrameKind.IssueConflict]: (wire) => conflicts('issue', wire),
  }
}
