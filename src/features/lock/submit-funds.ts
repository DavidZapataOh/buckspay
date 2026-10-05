import type { Address } from '@solana/kit'
import {
  type Activation,
  type ActivationContext,
  type ActivationInput,
  checkInput,
  isSponsored,
  lockUntil,
  split,
} from '../identity/activation'
import { formatSol } from '../../utils/format-sol'
import { lockOperation } from './operations'
import { type OperationOutcome, runOperation, type RunContext } from './run-operation'
import type { Sponsorship } from '../identity/device-identity'

/**
 * Adds a lock of `input` to this phone's registration: through the gateway when its terms allow,
 * otherwise with the wallet paying. A request that cannot succeed is refused before the wallet is
 * asked, and says so.
 */
export async function addFunds(
  ctx: ActivationContext & RunContext,
  offer: Activation,
  sponsorship: Sponsorship | undefined,
  { wallet, key, lockSeq }: { wallet: Address; key: Uint8Array; lockSeq: number },
  input: ActivationInput,
): Promise<OperationOutcome> {
  const sponsored = isSponsored(offer, sponsorship, input)
  const invalid = checkInput(offer, input, sponsored)
  if (invalid) return { status: 'failed', error: invalid, payInstead: false }
  const { sol } = offer
  if (!sponsored && sol.balance < sol.cost) {
    return {
      status: 'failed',
      error: `Your wallet has ${formatSol(sol.balance)} SOL and this costs about ${formatSol(sol.cost, 'up')} SOL in network costs. Add SOL to your wallet, then try again. Nothing was sent.`,
      payInstead: false,
    }
  }
  const { bond, backing } = split(input.amount)
  const operation = lockOperation({
    programAddress: ctx.programAddress,
    wallet,
    key,
    funder: offer.funding.account,
    mint: offer.funding.mint,
    tokenProgram: offer.funding.tokenProgram,
    bond,
    backing,
    lockUntil: lockUntil(input.lockDays),
    lockSeq,
  })
  return runOperation(ctx, operation, sponsored)
}
