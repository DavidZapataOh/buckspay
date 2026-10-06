import { bytesToHex } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { encodeIssue, encodeSpend, GRACE } from '../../protocol'
import type { NoteDb } from '../notes/db'
import type { NoteChain } from '../settlement/chain'
import { loadConfig } from './config'
import { encodeInner } from './inner'
import { outboxFor, queueSealed } from './outbox'
import { sealRelay } from './seal'

/**
 * What an offline phone does with a note it holds and cannot settle: seals it to the gateway and queues it for the
 * first online phone it meets. A note is queued once; a phone with no pinned key left for today queues nothing.
 */
export function relayQueue(db: NoteDb, genesisHash: Uint8Array, now: () => number) {
  return async ({ outputId, chain, expiry }: { outputId: Uint8Array; chain: NoteChain; expiry: number }) => {
    const ref = bytesToHex(outputId)
    if (await outboxFor(db, ref)) return
    const inner = encodeInner(encodeIssue(chain.issue), chain.spends.map(encodeSpend))
    const sealed = await sealRelay(await loadConfig(db), genesisHash, inner, now())
    await queueSealed(db, { id: sha256(sealed.blob), ref, sealed, now: now(), expiresAt: expiry + GRACE })
  }
}
