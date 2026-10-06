import { sha256 } from '@noble/hashes/sha2.js'
import type { NoteDb } from '../notes/db'
import { accept, forward, RelayRejected } from './inbox'
import { type Channel, openHop } from './hop'

const BLOB_TIMEOUT_MS = 5_000
const STORED = Uint8Array.of(0x01)
const REFUSED = Uint8Array.of(0x00)

/**
 * What a relayer does for a phone that connected to it: takes the blob, says whether it kept it, posts it to the
 * gateway and passes the sealed answer back over the same channel. The relayer cannot read the answer.
 */
export async function serveChannel(
  db: NoteDb,
  channel: Channel,
  peer: string,
  post: (blob: Uint8Array) => Promise<Uint8Array>,
  now: () => number,
): Promise<void> {
  try {
    const hop = await openHop(channel, 'responder')
    const blob = await hop.receive(BLOB_TIMEOUT_MS)
    const accepted = await accept(db, blob, now(), peer)
    if (accepted === 'dropped' || accepted === 'full') {
      await hop.send(REFUSED)
      return
    }
    await hop.send(STORED)
    if (typeof accepted === 'object') {
      if (accepted.repeat) await hop.send(accepted.repeat)
      return
    }
    await forward(db, post, now())
    const [kept] = await db.all<{ response: Uint8Array }>('SELECT response FROM relay_seen WHERE id = ?', [
      sha256(blob),
    ])
    if (kept) await hop.send(kept.response)
  } catch {
    // The sender went away or sent something that is not a hop: nothing is owed.
  } finally {
    channel.close()
  }
}

/** Posts a sealed settlement to the gateway; a refusal of the blob itself (`400`) is told apart from a failure to reach it. */
export function postRelay(gatewayUrl: string, request: typeof fetch = fetch) {
  return async (blob: Uint8Array): Promise<Uint8Array> => {
    const response = await request(`${gatewayUrl}/v1/relay`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: blob as BodyInit,
    })
    if (response.status === 400) throw new RelayRejected()
    if (!response.ok) throw new Error(`The gateway answered ${response.status}.`)
    return new Uint8Array(await response.arrayBuffer())
  }
}
