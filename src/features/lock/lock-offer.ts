import { getLedgerSize, getLockSize } from '@project/anchor'
import type { Address } from '@solana/kit'
import { type Activation, type ActivationContext, selfPaidCost, TOKEN_ACCOUNT_SIZE } from '../identity/activation'
import { readFunding } from './funding'
import { readQuote } from '../identity/activation'
import { lockOperation } from './operations'
import { minLockSeconds } from '../../protocol'

const DAY = 86_400

/**
 * What adding funds to an activated phone offers: the same terms as an activation, without the
 * device account's rent, and without the fee, which only an activation pays.
 */
export async function readLockOffer(
  ctx: ActivationContext,
  wallet: Address,
  key: Uint8Array,
  lockSeq: number,
): Promise<Activation> {
  const funding = await readFunding(ctx.rpc, wallet, ctx.mint)
  const quote = await readQuote(ctx.gateway)
  const defaultAmount = 5n * 10n ** BigInt(funding.decimals)
  const template = lockOperation({
    programAddress: ctx.programAddress,
    wallet,
    key,
    funder: funding.account,
    mint: funding.mint,
    tokenProgram: funding.tokenProgram,
    bond: (defaultAmount * 2n) / 5n,
    backing: defaultAmount - (defaultAmount * 2n) / 5n,
    lockUntil: Math.floor(Date.now() / 1000) + 30 * DAY,
    lockSeq,
  })
  const [{ value: balance }, cost] = await Promise.all([
    ctx.rpc.getBalance(wallet, { commitment: 'confirmed' }).send(),
    selfPaidCost(ctx, template, wallet, [BigInt(getLockSize()), BigInt(getLedgerSize()), TOKEN_ACCOUNT_SIZE]),
  ])
  return {
    funding,
    quote: quote && { ...quote, fee: 0n },
    sol: { balance, cost },
    defaultAmount: quote && quote.minFunding > defaultAmount ? quote.minFunding : defaultAmount,
    defaultLockDays: 30,
    minLockDays: Math.max(1, Math.ceil(minLockSeconds(ctx.windows) / DAY)),
    maxLockDays: 365,
  }
}
