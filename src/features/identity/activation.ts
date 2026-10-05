import { getDeviceSize, getLedgerSize, getLockSize } from '@project/anchor'
import {
  type Address,
  compileTransaction,
  createNoopSigner,
  getBase64Decoder,
  type GetBalanceApi,
  type GetFeeForMessageApi,
  type GetMinimumBalanceForRentExemptionApi,
  type GetMultipleAccountsApi,
  type Rpc,
  type TransactionMessageBytesBase64,
} from '@solana/kit'
import { signDeviceBinding } from '../../keys'
import { minLockSeconds, type Windows } from '../../protocol'
import { formatAmount } from '../../utils/format-amount'
import { type Funding, readFunding } from '../lock/funding'
import type { Gateway, Quote } from '../lock/gateway'
import { type OperationContext, selfPaidMessage } from '../lock/gateway-onboard'
import { FUNDING_SYMBOL } from '../lock/lock-copy'
import { onboardOperation, type Operation } from '../lock/operations'
import type { PerformContext } from '../lock/perform'

export type ActivationInput = { amount: bigint; lockDays: number }

/** What the activation step offers: the funds, the sponsor's terms, and what paying itself would cost. */
export type Activation = {
  funding: Funding
  /** The gateway's terms; absent without a gateway or when it could not be asked. */
  quote?: Quote
  /** The wallet's SOL and what the network costs and rents add up to when the wallet pays them. */
  sol: { balance: bigint; cost: bigint }
  defaultAmount: bigint
  defaultLockDays: number
  minLockDays: number
  /** The longest lock the program accepts. */
  maxLockDays: number
}

export type ActivationContext = PerformContext & {
  rpc: OperationContext['rpc'] &
    Rpc<GetBalanceApi & GetFeeForMessageApi & GetMinimumBalanceForRentExemptionApi & GetMultipleAccountsApi>
  /** The mint that funds locks. */
  mint: Address
  windows: Windows
}

const commitment = 'confirmed'
const DAY = 86_400
const DEFAULT_FUNDING = 5
const DEFAULT_LOCK_DAYS = 30
const MAX_LOCK_DAYS = 365
/** The size of the escrow, an SPL token account. */
export const TOKEN_ACCOUNT_SIZE = 165n

/** The 40/60 split of the funds between the bond and the backing a note is issued against. */
export const split = (amount: bigint) => {
  const bond = (amount * 2n) / 5n
  return { bond, backing: amount - bond }
}

export const lockUntil = (lockDays: number, now = Date.now()) => Math.floor(now / 1000) + lockDays * DAY

/** Whether the gateway pays for an activation with these terms: they are within what it quoted. */
export const isSponsored = (activation: Activation, sponsorship: string | undefined, input: ActivationInput) =>
  sponsorship === 'free' &&
  activation.quote !== undefined &&
  input.amount >= activation.quote.minFunding &&
  input.lockDays <= activation.quote.maxLockDays

/** Why `input` cannot be activated, in plain words, or `undefined`. Nothing has been sent. */
export function checkInput(activation: Activation, input: ActivationInput, sponsored: boolean): string | undefined {
  const { funding, quote, minLockDays, maxLockDays } = activation
  if (input.amount <= 0n) return 'Enter an amount to add. Nothing was sent.'
  const longest = sponsored && quote ? quote.maxLockDays : maxLockDays
  if (!Number.isInteger(input.lockDays) || input.lockDays < minLockDays || input.lockDays > longest) {
    return `Choose a lock of ${minLockDays} to ${longest} days. Nothing was sent.`
  }
  const total = input.amount + (sponsored && quote ? quote.fee : 0n)
  if (total > funding.balance) {
    return `Your wallet has ${formatAmount(funding.balance, funding.decimals)} ${FUNDING_SYMBOL} and this needs ${formatAmount(total, funding.decimals)} ${FUNDING_SYMBOL}. Add ${FUNDING_SYMBOL} to your wallet, then try again. Nothing was sent.`
  }
  return undefined
}

/** The activation of `wallet`: this key's registration and first lock in one transaction. */
export async function activationOperation(
  { programAddress }: Pick<ActivationContext, 'programAddress'>,
  wallet: Address,
  funding: Funding,
  { amount, lockDays }: ActivationInput,
  sponsorFee: bigint,
): Promise<Operation> {
  const { bond, backing } = split(amount)
  return onboardOperation({
    programAddress,
    wallet,
    binding: await signDeviceBinding(wallet),
    funder: funding.account,
    mint: funding.mint,
    tokenProgram: funding.tokenProgram,
    bond,
    backing,
    lockUntil: lockUntil(lockDays),
    sponsorFee,
  })
}

/** The network fee of `operation` plus the rent of each account of `accountSizes` that it creates. */
export async function selfPaidCost(
  ctx: ActivationContext,
  operation: Operation,
  wallet: Address,
  accountSizes: bigint[],
) {
  const { value: latestBlockhash } = await ctx.rpc.getLatestBlockhash({ commitment }).send()
  const message = await selfPaidMessage(operation, createNoopSigner(wallet), latestBlockhash)
  const messageBytes = getBase64Decoder().decode(
    compileTransaction(message).messageBytes,
  ) as TransactionMessageBytesBase64
  const rent = (size: bigint) => ctx.rpc.getMinimumBalanceForRentExemption(size, { commitment }).send()
  const [{ value: fee }, ...rents] = await Promise.all([
    ctx.rpc.getFeeForMessage(messageBytes, { commitment }).send(),
    ...accountSizes.map(rent),
  ])
  if (fee === null) throw new Error('Solana no longer knows the activation’s blockhash.')
  return rents.reduce<bigint>((sum, lamports) => sum + lamports, fee)
}

/** The gateway's terms, or `undefined` without a gateway or when it cannot be asked. */
export async function readQuote(gateway: Gateway | undefined) {
  if (!gateway) return undefined
  try {
    return await gateway.quote()
  } catch {
    return undefined
  }
}

/** Reads what the activation step offers `wallet`. */
export async function readActivation(
  ctx: ActivationContext,
  wallet: Address,
  quote: Quote | undefined,
): Promise<Activation> {
  const funding = await readFunding(ctx.rpc, wallet, ctx.mint)
  const defaultAmount = BigInt(DEFAULT_FUNDING) * 10n ** BigInt(funding.decimals)
  const input = { amount: defaultAmount, lockDays: DEFAULT_LOCK_DAYS }
  const template = await activationOperation(ctx, wallet, funding, input, 0n)
  const [{ value: balance }, cost] = await Promise.all([
    ctx.rpc.getBalance(wallet, { commitment }).send(),
    selfPaidCost(ctx, template, wallet, [
      BigInt(getDeviceSize()),
      BigInt(getLockSize()),
      BigInt(getLedgerSize()),
      TOKEN_ACCOUNT_SIZE,
    ]),
  ])
  const minLockDays = Math.max(1, Math.ceil(minLockSeconds(ctx.windows) / DAY))
  return {
    funding,
    quote,
    sol: { balance, cost },
    defaultAmount: quote && quote.minFunding > defaultAmount ? quote.minFunding : defaultAmount,
    defaultLockDays: DEFAULT_LOCK_DAYS,
    minLockDays,
    maxLockDays: MAX_LOCK_DAYS,
  }
}
