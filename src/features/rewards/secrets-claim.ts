import { ed25519 } from '@noble/curves/ed25519.js'
import { getAddressDecoder } from '@solana/kit'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import type { RewardsGateway } from '../lock/gateway'
import type { NoteDb } from '../notes/db'
import type { ClaimProverNative } from '../zk/native'
import type { KeyOffer } from '../zk/types'
import { buildClaimRequest, type JobAnswer } from './api'
import { loadLeafSecrets, type LeafSecret } from './secrets'
import { BN254_R, fromCanonical, poseidon2, toBytes32 } from './secrets-poseidon'
import { merklePath, TREE_DEPTH } from './secrets-tree'

/** The seconds before a claim is asked for again when the gateway gave no time. */
export const CLAIM_RETRY_AFTER = 3_600
export const CLAIM_REQUEST_BYTES = 32 * 3 + 16 + 1 + 32 * 2 + 4 + TREE_DEPTH * 32
export const CLAIM_PROOF_BYTES = 128

/** What a proof is bound to: `SHA-256("buckspay/reward" ‖ program id ‖ mint ‖ genesis hash)` reduced into the field. */
export function rewardScope(programId: Uint8Array, mint: Uint8Array, genesisHash: Uint8Array): Uint8Array {
  const hash = sha256(concatBytes(utf8ToBytes('buckspay/reward'), programId, mint, genesisHash))
  return toBytes32(BigInt(`0x${bytesToHex(hash)}`) % BN254_R)
}

/** The recipient as the circuit reads it: the first and the last 16 bytes, each as a number. */
export const recipientLimbs = (recipient: Uint8Array): [Uint8Array, Uint8Array] => {
  if (recipient.length !== 32) throw new Error('A recipient is 32 bytes')
  return [
    toBytes32(BigInt(`0x${bytesToHex(recipient.subarray(0, 16))}`)),
    toBytes32(BigInt(`0x${bytesToHex(recipient.subarray(16))}`)),
  ]
}

export type ClaimWire = {
  root: Uint8Array
  scope: Uint8Array
  recipient: Uint8Array
  maxFee: bigint
  exp: number
  nullifier: Uint8Array
  trapdoor: Uint8Array
  index: number
  siblings: readonly Uint8Array[]
}

const hex16 = (value: bigint) => {
  const out = new Uint8Array(16)
  for (let i = 15; i >= 0; i--, value >>= 8n) out[i] = Number(value & 0xffn)
  return out
}

/** The request the prover reads: root, scope, recipient, max fee (16 bytes), exponent, nullifier, trapdoor, index (4 bytes), then the 20 siblings. */
export function encodeClaimRequest(wire: ClaimWire): Uint8Array {
  if (wire.siblings.length !== TREE_DEPTH) throw new Error(`A path has ${TREE_DEPTH} siblings`)
  if (wire.maxFee < 0n || wire.maxFee >= 1n << 128n) throw new Error('The maximum fee is below 2^128')
  if (!Number.isInteger(wire.exp) || wire.exp < 0 || wire.exp > 7) throw new Error('A leaf exponent is at most 7')
  if (!Number.isInteger(wire.index) || wire.index < 0 || wire.index >= 2 ** TREE_DEPTH)
    throw new Error('The leaf index is outside the tree')
  for (const [name, value] of [
    ['root', wire.root],
    ['scope', wire.scope],
    ['nullifier', wire.nullifier],
    ['trapdoor', wire.trapdoor],
  ] as const)
    fromCanonical(value, name)
  if (wire.recipient.length !== 32) throw new Error('A recipient is 32 bytes')
  wire.siblings.forEach((sibling, k) => fromCanonical(sibling, `sibling ${k}`))
  const index = new Uint8Array(4)
  new DataView(index.buffer).setUint32(0, wire.index)
  const out = concatBytes(
    wire.root,
    wire.scope,
    wire.recipient,
    hex16(wire.maxFee),
    Uint8Array.of(wire.exp),
    wire.nullifier,
    wire.trapdoor,
    index,
    ...wire.siblings,
  )
  if (out.length !== CLAIM_REQUEST_BYTES) throw new Error('The claim request has the wrong size')
  return out
}

/** The seven public inputs a claim of this secret must prove, in verifier order. */
export function expectedPublics(
  secret: Pick<LeafSecret, 'nullifier' | 'exp'>,
  root: Uint8Array,
  scope: Uint8Array,
  recipient: Uint8Array,
  maxFee: bigint,
): Uint8Array {
  const [hi, lo] = recipientLimbs(recipient)
  const nullifierHash = toBytes32(
    poseidon2(fromCanonical(secret.nullifier, 'nullifier'), fromCanonical(scope, 'scope')),
  )
  return concatBytes(root, nullifierHash, scope, hi, lo, toBytes32(BigInt(secret.exp)), toBytes32(maxFee))
}

/** The key the gateway names a claim by: SHA-256 of the nullifier hashes it carries, here one. */
export const claimJobKey = (nullifierHash: Uint8Array) => bytesToHex(sha256(nullifierHash))

export type RewardTreeData = {
  /** Every leaf of the epoch's tree from index 0, as many as the chain counts. */
  leaves: Uint8Array[]
  /** The latest root the chain holds for the epoch. */
  root: Uint8Array
}

export type ClaimContext = {
  now: number
  scope: Uint8Array
  maxFee: bigint
  tree: (epoch: number) => Promise<RewardTreeData>
  /** The latest root of an epoch on the chain: a proof made against another is made again. */
  latestRoot: (epoch: number) => Promise<Uint8Array>
  /** The claim key this phone may use: one the program or the build vouches for, never one the gateway names alone. */
  key: () => Promise<KeyOffer | undefined>
  prover: ClaimProverNative
  gateway: Pick<RewardsGateway, 'submitClaims' | 'claimStatus'>
}

export type ClaimProgress = { enqueued: number; submitted: number; claimed: number; failed: number; waiting: number }

const REFUSAL: Record<string, string> = {
  invalid: 'The gateway refused this claim as invalid.',
  spent: 'This reward was already claimed.',
  fee: 'The claim fee is above what this reward allows.',
  below_fee: 'This reward is worth less than the claim fee.',
  window: 'The claim window is closed.',
  conflict: 'The gateway found a conflict with this claim.',
  lock: 'The gateway is not accepting claims right now.',
}

const same = (a: Uint8Array, b: Uint8Array) => bytesToHex(a) === bytesToHex(b)

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const note = (db: NoteDb, leaf: Uint8Array, error: string) =>
  db.run('UPDATE leaf_secrets SET error = ? WHERE leaf = ?', [error, leaf])

const fail = (db: NoteDb, leaf: Uint8Array, error: string) =>
  db.run("UPDATE leaf_secrets SET state = 'failed', error = ? WHERE leaf = ?", [error, leaf])

const reprove = (db: NoteDb, leaf: Uint8Array, claimAt: number, error: string) =>
  db.run("UPDATE leaf_secrets SET state = 'in_tree', claim_at = ?, error = ? WHERE leaf = ?", [claimAt, error, leaf])

const claimId = (secret: LeafSecret) => bytesToHex(secret.leaf)

/**
 * Moves every scheduled reward claim along one step: a leaf whose time has come is proved against the latest root of its
 * tree in the prover process, the proof is posted through the gateway, and a posted claim is watched until it settles.
 * Every failure is written on the leaf (`error`, and `failed` when it cannot succeed), so nothing disappears quietly.
 * Safe to run again after any interruption.
 */
export async function advanceClaims(db: NoteDb, ctx: ClaimContext): Promise<ClaimProgress> {
  const progress: ClaimProgress = { enqueued: 0, submitted: 0, claimed: 0, failed: 0, waiting: 0 }
  const secrets = await loadLeafSecrets(db, ['in_tree', 'proving', 'submitted'])
  for (const secret of secrets) {
    try {
      if (secret.state === 'submitted') await watch(db, ctx, secret, progress)
      else if (secret.state === 'proving') await collect(db, ctx, secret, progress)
      else if (secret.claimAt !== null && secret.claimAt <= ctx.now) await start(db, ctx, secret, progress)
      else progress.waiting++
    } catch (error) {
      await note(db, secret.leaf, message(error))
    }
  }
  return progress
}

async function readyKey(db: NoteDb, ctx: ClaimContext, secret: LeafSecret): Promise<KeyOffer | undefined> {
  const key = await ctx.key()
  if (!key) {
    await note(db, secret.leaf, 'No trusted claim key is available yet.')
    return undefined
  }
  const status = await ctx.prover.keyStatus(key.vkSha256)
  if (status.state !== 'ready') {
    await ctx.prover.ensureKey(key, true)
    await note(db, secret.leaf, 'The claim key is downloading.')
    return undefined
  }
  return key
}

async function start(db: NoteDb, ctx: ClaimContext, secret: LeafSecret, progress: ClaimProgress) {
  if (secret.epoch === null || secret.leafIndex === null) throw new Error('This leaf has no place in a tree.')
  const key = await readyKey(db, ctx, secret)
  if (!key) return
  const data = await ctx.tree(secret.epoch)
  if (!data.leaves[secret.leafIndex] || !same(data.leaves[secret.leafIndex], secret.leaf)) {
    await fail(db, secret.leaf, 'The reward tree does not hold this leaf.')
    progress.failed++
    return
  }
  const path = merklePath(data.leaves, secret.leafIndex)
  if (!same(path.root, data.root)) throw new Error('The reward tree data does not match the root on the chain.')
  const seed = secret.recipientSecret ?? ed25519.utils.randomSecretKey()
  const recipient = secret.recipient ?? ed25519.getPublicKey(seed)
  if (!secret.recipient)
    await db.run('UPDATE leaf_secrets SET recipient = ?, recipient_secret = ? WHERE leaf = ? AND recipient IS NULL', [
      recipient,
      seed,
      secret.leaf,
    ])
  const request = encodeClaimRequest({
    root: path.root,
    scope: ctx.scope,
    recipient,
    maxFee: ctx.maxFee,
    exp: secret.exp,
    nullifier: secret.nullifier,
    trapdoor: secret.trapdoor,
    index: secret.leafIndex,
    siblings: path.siblings,
  })
  await ctx.prover.enqueueClaim(claimId(secret), request, key.vkSha256)
  await db.run("UPDATE leaf_secrets SET state = 'proving', error = NULL WHERE leaf = ?", [secret.leaf])
  progress.enqueued++
}

async function collect(db: NoteDb, ctx: ClaimContext, secret: LeafSecret, progress: ClaimProgress) {
  const key = await ctx.key()
  if (!key) return void (await note(db, secret.leaf, 'No trusted claim key is available yet.'))
  const id = claimId(secret)
  const made = await ctx.prover.collectClaim(id, key.vkSha256)
  if (!made) {
    const { state, reason } = await ctx.prover.claimState(id)
    if (state === 'failed' && reason === 'invalid') {
      await fail(db, secret.leaf, 'The prover refused this claim.')
      await ctx.prover.forgetClaim(id)
      progress.failed++
    } else if (state === 'failed' || state === 'cancelled' || state === 'unknown') {
      await reprove(
        db,
        secret.leaf,
        ctx.now,
        state === 'failed' ? 'The claim key is missing; proving again.' : 'Proving was interrupted; proving again.',
      )
    } else progress.waiting++
    return
  }
  if (!secret.recipient || secret.epoch === null) throw new Error('A proved claim has no recipient.')
  const published = made.publicInputs
  const root = published.slice(0, 32)
  if (
    made.proof.length !== CLAIM_PROOF_BYTES ||
    !same(published, expectedPublics(secret, root, ctx.scope, secret.recipient, ctx.maxFee))
  ) {
    await fail(db, secret.leaf, 'The proof does not state this claim.')
    await ctx.prover.forgetClaim(id)
    progress.failed++
    return
  }
  const latest = await ctx.latestRoot(secret.epoch)
  if (!same(root, latest)) {
    await reprove(db, secret.leaf, ctx.now, 'The reward tree moved on; proving again.')
    await ctx.prover.forgetClaim(id)
    return
  }
  const nullifierHash = published.slice(32, 64)
  const answer = await ctx.gateway.submitClaims(
    buildClaimRequest([{ epoch: secret.epoch, root, nullifierHash, exp: secret.exp, proof: made.proof }], {
      latestRoots: new Map([[secret.epoch, latest]]),
      maxFee: Number(ctx.maxFee),
      vkSha256: hexToBytes(key.vkSha256),
      recipient: getAddressDecoder().decode(secret.recipient),
    }),
  )
  await record(db, ctx, secret, answer, claimJobKey(nullifierHash), progress)
  await ctx.prover.forgetClaim(id)
}

async function record(
  db: NoteDb,
  ctx: ClaimContext,
  secret: LeafSecret,
  answer: JobAnswer,
  derivedKey: string,
  progress: ClaimProgress,
) {
  if (answer.status === 'submitted' || answer.status === 'duplicate') {
    await db.run("UPDATE leaf_secrets SET state = 'submitted', job_key = ?, error = NULL WHERE leaf = ?", [
      answer.jobKey ?? derivedKey,
      secret.leaf,
    ])
    progress.submitted++
  } else if (answer.status === 'settled') {
    await db.run("UPDATE leaf_secrets SET state = 'claimed', job_key = ?, signature = ?, error = NULL WHERE leaf = ?", [
      derivedKey,
      answer.signature,
      secret.leaf,
    ])
    progress.claimed++
  } else if (answer.status === 'retry') {
    await reprove(
      db,
      secret.leaf,
      ctx.now + (answer.retryAfter > 0 ? answer.retryAfter : CLAIM_RETRY_AFTER),
      'The gateway asked to try again later.',
    )
  } else if (answer.status === 'refused') {
    if (answer.reason === 'stale_key') await reprove(db, secret.leaf, ctx.now, 'The claim key changed; proving again.')
    else {
      await fail(db, secret.leaf, REFUSAL[answer.reason] ?? 'The gateway refused this claim.')
      progress.failed++
    }
  }
}

async function watch(db: NoteDb, ctx: ClaimContext, secret: LeafSecret, progress: ClaimProgress) {
  if (!secret.jobKey) return
  const answer = await ctx.gateway.claimStatus(secret.jobKey)
  if (answer.status === 'settled') {
    await db.run("UPDATE leaf_secrets SET state = 'claimed', signature = ?, error = NULL WHERE leaf = ?", [
      answer.signature,
      secret.leaf,
    ])
    progress.claimed++
  } else if (answer.status === 'refused') {
    await fail(db, secret.leaf, REFUSAL[answer.reason] ?? 'The gateway refused this claim.')
    progress.failed++
  }
}

/** Reads the leaves of a reward tree epoch from `GET /v1/rewards/trees/{epoch}`: 32 bytes each, from index 0. */
export function fetchRewardLeaves(gatewayUrl: string, request: typeof fetch = fetch) {
  return async (epoch: number): Promise<Uint8Array[]> => {
    const response = await request(`${gatewayUrl}/v1/rewards/trees/${epoch}`)
    if (!response.ok) throw new Error(`The gateway answered ${response.status}.`)
    const body = new Uint8Array(await response.arrayBuffer())
    if (body.length % 32 !== 0) throw new Error('The reward tree data is malformed.')
    const leaves: Uint8Array[] = []
    for (let at = 0; at < body.length; at += 32) leaves.push(body.slice(at, at + 32))
    return leaves
  }
}
