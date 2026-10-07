import { deviceKeyCluster } from '../../keys'
import { genesisHashOf, paymentDomains } from '../../payment/domains'
import { BUILD_GATEWAY_URL } from '../lock/gateway'
import { syncBeacon } from '../relay/beacon-sync'
import { postCarried } from '../relay/carry'
import { postRelay, serveChannel } from '../relay/relayer'
import type { NoteDb } from '../notes/db'
import { openNoteDb } from '../notes/key'
import { FrameKind } from './frame'
import { conflictHandlers } from './handlers'
import { channelOf, l2capLink, meshNative } from './native'
import { settleNow } from './settle-flagged'
import type { MeshHandlers } from './task'
import { beaconsSeen, recordBeacon } from '../relay/beacons'
import { runHandoffs } from '../relay/run'
import { fetchWord, pollWords, postChannels, submitDue } from '../relay/words'
import { runAll } from '../relay/words-settle'
import { innerMaker } from '../rewards/secrets'

const seconds = () => Math.floor(Date.now() / 1000)

let store: Promise<NoteDb> | undefined
let lastHandOff = 0
const HAND_OFF_EVERY = 10
let online = false

/** What waits to leave this phone is handed to the phones in range, at most once every ten seconds. */
async function handOffSoon(): Promise<void> {
  const cluster = deviceKeyCluster()
  if (!cluster || seconds() - lastHandOff < HAND_OFF_EVERY) return
  lastHandOff = seconds()
  const db = await (store ??= openNoteDb())
  await runHandoffs({
    db,
    link: l2capLink,
    clusterTag: genesisHashOf(cluster).slice(0, 4),
    beacons: beaconsSeen(seconds()),
    now: seconds(),
  }).catch(() => undefined)
}

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
    [FrameKind.Beacon]: async (payload, rssi, address) => {
      recordBeacon(address, payload, rssi, seconds())
      await handOffSoon()
    },
  }
}

/** A phone connected to this one to hand over a payment: takes it, posts it and passes the sealed answer back. */
export async function serveInbound(channel: number, peer: string): Promise<void> {
  const db = await (store ??= openNoteDb())
  await serveChannel(db, channelOf(channel), peer, postRelay(BUILD_GATEWAY_URL ?? ''), seconds, online)
}

/** Tells the air whether this phone can take a payment to the internet right now. A phone without a cluster says nothing. */
export async function syncRelay(): Promise<void> {
  const cluster = deviceKeyCluster()
  if (!cluster || !BUILD_GATEWAY_URL) return
  const db = await (store ??= openNoteDb())
  online = await syncBeacon({
    db,
    native: meshNative,
    genesisHash: genesisHashOf(cluster),
    fetchConfig: async () => (await fetch(`${BUILD_GATEWAY_URL}/v1/hpke-config`)).json(),
    now: seconds,
  }).catch(() => false)
  if (!online) return
  await postCarried(db, postRelay(BUILD_GATEWAY_URL), seconds()).catch(() => undefined)
  await settleRelayWork(db, cluster, BUILD_GATEWAY_URL)
}

/**
 * What an online relayer owes its words: asks for the words of the payments it posted, settles the words it holds once
 * there are enough or the oldest has waited long enough.
 */
async function settleRelayWork(
  db: NoteDb,
  cluster: NonNullable<ReturnType<typeof deviceKeyCluster>>,
  gatewayUrl: string,
) {
  const genesisHash = genesisHashOf(cluster)
  await runAll([
    ['words', () => pollWords(db, fetchWord(gatewayUrl), genesisHash, seconds())],
    [
      'settlement',
      () => submitDue(db, { now: seconds(), makeInner: innerMaker(db, seconds), post: postChannels(gatewayUrl) }),
    ],
  ])
}
