import { deviceKeyCluster } from '../../keys'
import { genesisHashOf, paymentDomains } from '../../payment/domains'
import { BUILD_GATEWAY_URL } from '../lock/gateway'
import { syncBeacon } from '../relay/beacon-sync'
import { postRelay, serveChannel } from '../relay/relayer'
import type { NoteDb } from '../notes/db'
import { openNoteDb } from '../notes/key'
import { FrameKind } from './frame'
import { conflictHandlers } from './handlers'
import { channelOf, meshNative } from './native'
import { settleNow } from './settle-flagged'
import type { MeshHandlers } from './task'
import { recordBeacon } from '../relay/beacons'

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
    [FrameKind.Beacon]: async (payload, rssi, address) =>
      recordBeacon(address, payload, rssi, Math.floor(Date.now() / 1000)),
  }
}

const seconds = () => Math.floor(Date.now() / 1000)

/** A phone connected to this one to hand over a payment: takes it, posts it and passes the sealed answer back. */
export async function serveInbound(channel: number, peer: string): Promise<void> {
  const db = await (store ??= openNoteDb())
  await serveChannel(db, channelOf(channel), peer, postRelay(BUILD_GATEWAY_URL ?? ''), seconds)
}

/** Tells the air whether this phone can take a payment to the internet right now. A phone without a cluster says nothing. */
export async function syncRelay(): Promise<void> {
  const cluster = deviceKeyCluster()
  if (!cluster || !BUILD_GATEWAY_URL) return
  const db = await (store ??= openNoteDb())
  await syncBeacon({
    db,
    native: meshNative,
    genesisHash: genesisHashOf(cluster),
    fetchConfig: async () => (await fetch(`${BUILD_GATEWAY_URL}/v1/hpke-config`)).json(),
    now: seconds,
  }).catch(() => undefined)
}
