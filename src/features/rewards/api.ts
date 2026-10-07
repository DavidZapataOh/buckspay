import { bytesToHex } from '@noble/hashes/utils.js'

/** What the gateway answers to a claim or a sweep, and to the status of one. */
export type JobAnswer =
  | { status: 'submitted' | 'duplicate'; jobKey?: string }
  | { status: 'settled'; signature: string; computeUnits?: number }
  | { status: 'retry'; retryAfter: number }
  | {
      status: 'refused'
      reason: 'invalid' | 'window' | 'conflict' | 'lock' | 'stale_key' | 'below_fee' | 'spent' | 'fee'
    }

/** One leaf to claim: its proof, made against `root`, the root of the tree of `epoch` the proof opens. */
export type ProvedClaim = {
  epoch: number
  root: Uint8Array
  nullifierHash: Uint8Array
  exp: number
  proof: Uint8Array
}

export type ClaimEntry = { epoch: number; root: string; nullifierHash: string; exp: number; proof: string }

/** The body of `POST /v1/claims`: values are base64, `maxFee` is in base units of the mint. */
export type ClaimRequest = { vkSha256: string; recipient: string; maxFee: number; claims: ClaimEntry[] }

/** The most leaves one claim transaction pays. */
export const MAX_CLAIMS_PER_TX = 4

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

/**
 * The request for claims proved against the latest root of their epochs. A proof against an older root is refused here
 * so that the app proves again: a root the gateway has seen only once would tell it which delivery the leaf came from.
 * The fee ceiling is always the mint's fixed one, the same value in every request.
 */
export function buildClaimRequest(
  claims: ProvedClaim[],
  context: {
    latestRoots: ReadonlyMap<number, Uint8Array>
    maxFee: number
    vkSha256: Uint8Array
    recipient: string
  },
): ClaimRequest {
  if (claims.length === 0 || claims.length > MAX_CLAIMS_PER_TX) throw new RangeError('a claim has one to four leaves')
  if (!Number.isSafeInteger(context.maxFee) || context.maxFee <= 0) throw new RangeError('the fee ceiling is not valid')
  return {
    vkSha256: base64(context.vkSha256),
    recipient: context.recipient,
    maxFee: context.maxFee,
    claims: claims.map((claim) => {
      const latest = context.latestRoots.get(claim.epoch)
      if (latest === undefined || bytesToHex(latest) !== bytesToHex(claim.root)) {
        throw new Error(`a proof is not against the latest root of epoch ${claim.epoch}`)
      }
      return {
        epoch: claim.epoch,
        root: base64(claim.root),
        nullifierHash: base64(claim.nullifierHash),
        exp: claim.exp,
        proof: base64(claim.proof),
      }
    }),
  }
}
