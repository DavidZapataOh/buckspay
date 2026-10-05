import {
  type ClaimAnswer,
  GatewayError,
  notSent,
  type ReclaimRequest,
  type SettlementGateway,
  type SettlementRequest,
} from '../lock/gateway'

/** Why the gateway did not sponsor a settlement or a reclaim. */
export type Refusal =
  /** The chain does not verify, or is not one the program takes. Nothing a retry changes. */
  | { kind: 'invalid'; message: string }
  /** Another message was recorded first for an output of the chain: keep both chains as evidence. */
  | { kind: 'conflict'; recorded: string }
  /** The payee holds no token account of the mint, and the gateway creates none. */
  | { kind: 'no_token_account' }
  /** Too late to settle (`window`), too early or too late to reclaim (`window`, `closed`, `deadline`), or the lock ended. */
  | { kind: 'window' | 'closed' | 'deadline' | 'lock_ended' }
  /** A record would stay closed for too long: the same request fits from `retryAt`, in Unix seconds. */
  | { kind: 'horizon'; retryAt: number }
  /** Below the smallest amount sponsored, in base units. */
  | { kind: 'below_minimum'; minimum: bigint }
  /** A limit of the gateway: try again after `retryAfter` seconds when it says. */
  | { kind: 'limited' | 'busy'; reason: string; retryAfter?: number }
  /** The lock does not exist, does not back the issue or holds too little. */
  | { kind: 'lock'; reason: string }

export type Outcome =
  /** The gateway sent the transaction (`signature`), or the last record was paid already. */
  | { kind: 'sent'; signature: string }
  | { kind: 'settled' }
  /** Not sponsored; `selfPay` says the wallet can submit the transaction itself. */
  | { kind: 'refused'; refusal: Refusal; selfPay: boolean }
  /** No answer that says whether the gateway sent it: keep the chain and ask again, the answer will be `settled`. */
  | { kind: 'unknown' }

const text = (value: unknown) => (typeof value === 'string' ? value : '')

function refusal({ status, message, body }: GatewayError): Refusal {
  const retryAfter = typeof body.retryAfter === 'number' ? body.retryAfter : undefined
  switch (message) {
    case 'conflict':
      return { kind: 'conflict', recorded: text(body.recorded) }
    case 'no_token_account':
      return { kind: 'no_token_account' }
    case 'window':
    case 'closed':
    case 'deadline':
    case 'lock_ended':
      return { kind: message }
    case 'horizon':
      return { kind: 'horizon', retryAt: Number(body.retryAt) }
    case 'below_minimum':
      return { kind: 'below_minimum', minimum: BigInt(text(body.minimum) || 0) }
    case 'no_lock':
    case 'wrong_lock':
    case 'insufficient_backing':
    case 'no_mint':
      return { kind: 'lock', reason: message }
  }
  if (status === 429) return { kind: 'limited', reason: message, retryAfter }
  if (status === 503) return { kind: 'busy', reason: message, retryAfter }
  return { kind: 'invalid', message }
}

async function run(send: () => ReturnType<SettlementGateway['settle']>): Promise<Outcome> {
  try {
    const answer = await send()
    return 'signature' in answer ? { kind: 'sent', signature: answer.signature } : { kind: 'settled' }
  } catch (error) {
    if (error instanceof GatewayError && notSent(error)) {
      return { kind: 'refused', refusal: refusal(error), selfPay: error.body.selfPay === true }
    }
    return { kind: 'unknown' }
  }
}

/** Sends a chain to settle, with no wallet prompt. */
export const settle = (gateway: SettlementGateway, request: SettlementRequest) => run(() => gateway.settle(request))

/** Sends the reclaim of an output nobody settled. */
export const reclaim = (gateway: SettlementGateway, request: ReclaimRequest) => run(() => gateway.reclaim(request))

/** What filing the loss of a payment that could not be settled came to. */
export type ClaimOutcome =
  /** The gateway filed it: the payer's bond burned twice the loss. Nobody is repaid. */
  | { kind: 'burned'; signature: string }
  /** The loss was claimed already. */
  | { kind: 'claimed' }
  /** The program refuses the claim, so it is not retried: no bond left, not a loss of this lock, too late. */
  | { kind: 'nothing_to_burn'; reason: string }
  /** The gateway could not say: keep the chain and file again later. */
  | { kind: 'unavailable'; retryAfter?: number }

const unclaimable = ['no_bond', 'not_claimable', 'over_coverage', 'claim_too_late', 'lock_ended']

/** Files the loss a chain proves, with no wallet prompt and no signature: nothing is paid for it. */
export async function fileClaim(gateway: SettlementGateway, request: SettlementRequest): Promise<ClaimOutcome> {
  try {
    const answer: ClaimAnswer = await gateway.claim(request)
    return 'signature' in answer ? { kind: 'burned', signature: answer.signature } : { kind: 'claimed' }
  } catch (error) {
    if (error instanceof GatewayError) {
      if (unclaimable.includes(error.message)) return { kind: 'nothing_to_burn', reason: error.message }
      const retryAfter = typeof error.body.retryAfter === 'number' ? error.body.retryAfter : undefined
      return retryAfter === undefined ? { kind: 'unavailable' } : { kind: 'unavailable', retryAfter }
    }
    return { kind: 'unavailable' }
  }
}
