import { bytesToHex } from '@noble/hashes/utils.js'
import type { NoteDb } from '../notes/db'
import type { NoteChain } from '../settlement/chain'
import { encodeProverChain, zkChain } from './chain-wire'
import type { ProverNative } from './native'
import { missing, provingMode, submitAt } from './policy'
import { list, put } from './proof-store'
import { answerToState, buildRequest, type ZkAnswer, type ZkSettlementRequest } from './settle-private'
import type { KeyOffer, PrivateSettlementState } from './types'

export type PrivateSettlerDeps = {
  db: NoteDb
  prover: Pick<ProverNative, 'keyStatus' | 'ensureKey' | 'enqueue' | 'collect' | 'acknowledge'>
  gateway: { settlePrivate(request: ZkSettlementRequest): Promise<ZkAnswer> }
  /** The key this phone may use now: one the program or the build vouches for, never one the gateway names alone. */
  trustedKey: () => Promise<KeyOffer | undefined>
  noteDomain: Uint8Array
  now: () => number
}

export type PrivateNote = {
  outputId: Uint8Array
  /** The chain with this phone's settlement spend as its last message. */
  chain: NoteChain
  /** The last second the note can still settle. */
  settleBy: number
  userAsked: boolean
}

const RETRY: PrivateSettlementState = { kind: 'failed', reason: 'retry' }

/** Moves one note along the private route a step at a time: key, proofs, then submission. Safe to call again after any interruption. */
export function createPrivateSettler(deps: PrivateSettlerDeps) {
  const { db, prover } = deps

  async function advance({ outputId, chain, settleBy, userAsked }: PrivateNote): Promise<PrivateSettlementState> {
    const noteId = bytesToHex(outputId)
    const key = await deps.trustedKey()
    if (!key) return RETRY
    const status = await prover.keyStatus(key.vkSha256)
    if (status.state !== 'ready') {
      await prover.ensureKey(key, !userAsked)
      return { kind: 'needs-key', progress: status.progress }
    }
    const shape = zkChain(deps.noteDomain, chain)
    const total = shape.messages.length
    const now = deps.now()
    const made = await prover.collect(noteId, key.vkSha256)
    for (const proof of made) await put(db, noteId, { ...proof, vkSha256: key.vkSha256 }, now)
    if (made.length > 0) {
      await prover.acknowledge(
        noteId,
        key.vkSha256,
        made.map((proof) => proof.index),
      )
    }
    const proofs = await list(db, noteId)
    const todo = missing(total, proofs, key.vkSha256)
    if (todo.length > 0) {
      const mode = provingMode({ userAsked, now, settleBy })
      await prover.enqueue(noteId, encodeProverChain(deps.noteDomain, chain), todo, key.vkSha256, mode)
      const proved = total - todo.length
      return mode === 'charging' ? { kind: 'waiting-for-charger', proved, total } : { kind: 'proving', proved, total }
    }
    const readyAt = Math.max(...(await createdAt(noteId)))
    if (now < submitAt({ noteId, readyAt, userAsked })) return { kind: 'ready' }
    try {
      return answerToState(await deps.gateway.settlePrivate(buildRequest(shape, proofs, key.vkSha256)))
    } catch {
      return RETRY
    }
  }

  const createdAt = async (noteId: string) =>
    (await db.all<{ created_at: number }>('SELECT created_at FROM zk_proofs WHERE note_id = ?', [noteId])).map(
      (row) => row.created_at,
    )

  return { advance }
}
