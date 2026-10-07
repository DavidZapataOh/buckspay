import { bytesToHex, randomBytes } from '@noble/hashes/utils.js'
import type { NoteDb } from '../notes/db'
import type { LeafRecord } from './state'
import { fromCanonical, poseidon2, toBytes32 } from './secrets-poseidon'
import { leafOf } from './secrets-tree'

export const MIN_LEAF_EXP = 1
export const MAX_LEAF_EXP = 7
/** A claim waits between one and twenty-four hours after its leaf is in the tree, so its time says little about the settlement. */
export const CLAIM_DELAY_MIN = 3_600
export const CLAIM_DELAY_MAX = 86_400
/** The secrets are 31 random bytes, so they are always below the field order. */
const SECRET_BYTES = 31

export type LeafState = 'made' | 'in_tree' | 'proving' | 'submitted' | 'claimed' | 'failed'

export type LeafSecret = {
  leaf: Uint8Array
  nullifier: Uint8Array
  trapdoor: Uint8Array
  inner: Uint8Array
  exp: number
  epoch: number | null
  leafIndex: number | null
  state: LeafState
  claimAt: number | null
  recipient: Uint8Array | null
  recipientSecret: Uint8Array | null
  jobKey: string | null
  signature: string | null
  /** What went wrong the last time something was tried, in words the rewards screen can show. */
  error: string | null
  createdAt: number
}

type Row = {
  leaf: Uint8Array
  nullifier: Uint8Array
  trapdoor: Uint8Array
  inner: Uint8Array
  exp: number
  epoch: number | null
  leaf_index: number | null
  state: LeafState
  claim_at: number | null
  recipient: Uint8Array | null
  recipient_secret: Uint8Array | null
  job_key: string | null
  signature: string | null
  error: string | null
  created_at: number
}

const toSecret = (row: Row): LeafSecret => ({
  leaf: row.leaf,
  nullifier: row.nullifier,
  trapdoor: row.trapdoor,
  inner: row.inner,
  exp: row.exp,
  epoch: row.epoch,
  leafIndex: row.leaf_index,
  state: row.state,
  claimAt: row.claim_at,
  recipient: row.recipient,
  recipientSecret: row.recipient_secret,
  jobKey: row.job_key,
  signature: row.signature,
  error: row.error,
  createdAt: row.created_at,
})

function secret31(random: (n: number) => Uint8Array): Uint8Array {
  for (;;) {
    const bytes = random(SECRET_BYTES)
    if (bytes.length === SECRET_BYTES && bytes.some((byte) => byte !== 0)) return bytes
  }
}

const pad = (bytes: Uint8Array) => {
  const out = new Uint8Array(32)
  out.set(bytes, 32 - bytes.length)
  return out
}

/**
 * Makes the secrets of a leaf of `2^exp` units: a nullifier and a trapdoor, both nonzero and below the field order,
 * and the blinded `inner = Poseidon(nullifier, trapdoor)` the relayer sends with its words. They are kept before
 * `inner` leaves the phone, so no word is settled for a leaf this phone cannot claim.
 */
export async function makeLeafSecret(
  db: NoteDb,
  exp: number,
  now: number,
  random: (n: number) => Uint8Array = randomBytes,
): Promise<LeafSecret> {
  if (!Number.isInteger(exp) || exp < MIN_LEAF_EXP || exp > MAX_LEAF_EXP)
    throw new Error(`A leaf exponent is ${MIN_LEAF_EXP} to ${MAX_LEAF_EXP}`)
  const nullifier = pad(secret31(random))
  const trapdoor = pad(secret31(random))
  const inner = toBytes32(poseidon2(fromCanonical(nullifier, 'nullifier'), fromCanonical(trapdoor, 'trapdoor')))
  const leaf = leafOf(inner, exp)
  await db.run(
    "INSERT INTO leaf_secrets (leaf, nullifier, trapdoor, inner, exp, state, created_at) VALUES (?, ?, ?, ?, ?, 'made', ?)",
    [leaf, nullifier, trapdoor, inner, exp, now],
  )
  return {
    leaf,
    nullifier,
    trapdoor,
    inner,
    exp,
    epoch: null,
    leafIndex: null,
    state: 'made',
    claimAt: null,
    recipient: null,
    recipientSecret: null,
    jobKey: null,
    signature: null,
    error: null,
    createdAt: now,
  }
}

export async function loadLeafSecrets(db: NoteDb, states?: readonly LeafState[]): Promise<LeafSecret[]> {
  const rows = await db.all<Row>(
    states?.length
      ? `SELECT * FROM leaf_secrets WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY created_at, leaf`
      : 'SELECT * FROM leaf_secrets ORDER BY created_at, leaf',
    states ?? [],
  )
  return rows.map(toSecret)
}

/** The `inner` for `submitDue`: the secrets are stored before they are returned. */
export const innerMaker =
  (db: NoteDb, now: () => number, random?: (n: number) => Uint8Array) =>
  async (exp: number): Promise<Uint8Array> =>
    (await makeLeafSecret(db, exp, now(), random)).inner

/** A uniform delay of `CLAIM_DELAY_MIN` to `CLAIM_DELAY_MAX` seconds, drawn without modulo bias. */
export function claimDelay(random: (n: number) => Uint8Array = randomBytes): number {
  const span = CLAIM_DELAY_MAX - CLAIM_DELAY_MIN + 1
  const limit = 2 ** 32 - (2 ** 32 % span)
  for (;;) {
    const [a, b, c, d] = random(4)
    const value = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0
    if (value < limit) return CLAIM_DELAY_MIN + (value % span)
  }
}

/**
 * Finds the leaves of this phone among the `leaves` of a reward tree epoch: each found leaf is `in_tree` with its place
 * and waits, unscheduled, until the user chooses to claim. Leaves that are not in the tree yet stay `made`.
 */
export async function locateLeaves(db: NoteDb, epoch: number, leaves: readonly Uint8Array[]): Promise<number> {
  const made = await loadLeafSecrets(db, ['made'])
  if (made.length === 0) return 0
  const where = new Map(leaves.map((leaf, index) => [bytesToHex(leaf), index]))
  let found = 0
  for (const entry of made) {
    const index = where.get(bytesToHex(entry.leaf))
    if (index === undefined) continue
    await db.run(
      "UPDATE leaf_secrets SET state = 'in_tree', epoch = ?, leaf_index = ?, error = NULL WHERE leaf = ? AND state = 'made'",
      [epoch, index, entry.leaf],
    )
    found++
  }
  return found
}

/**
 * The user chose to claim: every leaf in the tree that has no time yet, and every leaf whose claim failed, is scheduled
 * a random one to twenty-four hours from `now`, or at once when `immediate` (easier to link to its settlement).
 */
export async function scheduleClaims(
  db: NoteDb,
  now: number,
  { immediate }: { immediate: boolean },
  random: (n: number) => Uint8Array = randomBytes,
): Promise<number> {
  await db.run(
    "UPDATE leaf_secrets SET state = 'in_tree', claim_at = NULL, error = NULL, job_key = NULL WHERE state = 'failed' AND epoch IS NOT NULL",
  )
  const unscheduled = (await loadLeafSecrets(db, ['in_tree'])).filter((entry) => entry.claimAt === null)
  for (const entry of unscheduled)
    await db.run('UPDATE leaf_secrets SET claim_at = ? WHERE leaf = ?', [
      now + (immediate ? 0 : claimDelay(random)),
      entry.leaf,
    ])
  return unscheduled.length
}

/** What the rewards screen shows of the leaves: a leaf is claimable once the tree holds it. */
export async function leafRecords(db: NoteDb, unit: bigint): Promise<LeafRecord[]> {
  const shown = await loadLeafSecrets(db, ['in_tree', 'proving', 'submitted', 'claimed', 'failed'])
  return shown.map((entry) => ({
    kind: 'leaf',
    state:
      entry.state === 'claimed'
        ? 'claimed'
        : entry.state === 'proving' || entry.state === 'submitted'
          ? 'claiming'
          : 'unclaimed',
    exp: entry.exp,
    unit,
    ...(entry.signature ? { signature: entry.signature } : {}),
  }))
}
