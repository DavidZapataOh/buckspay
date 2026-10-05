import {
  compileTransaction,
  getBase58Decoder,
  type GetSignatureStatusesApi,
  type Rpc,
  signAndSendTransactionMessageWithSigners,
  type Signature,
  type TransactionError,
  type TransactionSendingSigner,
  type Address,
  type Transaction,
} from '@solana/kit'
import { notDelivered } from './gateway'
import {
  type OperationContext,
  prepareSponsored,
  selfPaidMessage,
  signSponsored,
  simulateTransaction,
  SponsorshipError,
  submitSponsored,
} from './gateway-onboard'
import type { Operation } from './operations'

export type PerformContext = OperationContext & {
  /** The wallet's sign-and-send signer (`useMobileWallet().getTransactionSigner`). */
  getTransactionSigner: (address: Address, minContextSlot: bigint) => TransactionSendingSigner
}

const commitment = 'confirmed'

/** Solana would reject a transaction the wallet was to pay for; nothing was sent. */
export class TransactionRejected extends Error {
  readonly error: TransactionError
  constructor(error: TransactionError) {
    super('Solana would reject the transaction')
    this.error = error
  }
}

/**
 * The gateway pays for `operation`: the app's own build of it is checked against the gateway's,
 * simulated, signed by the wallet without sending, then sent by the gateway. Throws a
 * `SponsorshipError` while nothing was sent, so the wallet may pay instead.
 */
export async function performSponsored(ctx: PerformContext, operation: Operation): Promise<string> {
  const id = `${operation.kind}:${JSON.stringify(operation.request)}`
  const held = undelivered.get(id)
  undelivered.delete(id)
  if (held && Date.now() - held.at < HELD_MS) return submitHeld(ctx, operation, id, held.signed)
  const sponsored = await prepareSponsored(ctx, operation)
  const rejected = await simulateTransaction(ctx, sponsored.transaction)
  if (rejected) throw new SponsorshipError('unavailable', new TransactionRejected(rejected))
  const signed = await signSponsored(ctx, operation.wallet, sponsored)
  return submitHeld(ctx, operation, id, signed)
}

/**
 * Signed transactions the gateway never received, by operation, so trying again hands it the same
 * signature instead of asking the wallet again. The gateway refuses one past its lifetime.
 */
const undelivered = new Map<string, { signed: Transaction; at: number }>()
const HELD_MS = 60_000

async function submitHeld(ctx: PerformContext, operation: Operation, id: string, signed: Transaction) {
  try {
    return await submitSponsored(ctx, operation, signed)
  } catch (error) {
    if (notDelivered(error)) undelivered.set(id, { signed, at: Date.now() })
    throw error
  }
}

/** The wallet signs, pays for and sends a built operation, once Solana's simulation accepted it. */
export async function buildSelfPaid(ctx: PerformContext, operation: Operation) {
  const {
    context: { slot },
    value: latestBlockhash,
  } = await ctx.rpc.getLatestBlockhash({ commitment }).send()
  const message = await selfPaidMessage(operation, ctx.getTransactionSigner(operation.wallet, slot), latestBlockhash)
  return { message, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight }
}

export type SelfPaid = Awaited<ReturnType<typeof buildSelfPaid>>

/** Has the wallet sign, pay for and send a built operation. */
export const sendSelfPaid = ({ message }: SelfPaid) => signAndSendTransactionMessageWithSigners(message)

export async function performSelfPaid(ctx: PerformContext, operation: Operation): Promise<string> {
  const built = await buildSelfPaid(ctx, operation)
  const rejected = await simulateTransaction(ctx, compileTransaction(built.message))
  if (rejected) throw new TransactionRejected(rejected)
  return getBase58Decoder().decode(await sendSelfPaid(built))
}

/**
 * Waits until the cluster confirms `signature`: `null` when it succeeded, the error when it failed,
 * `undefined` when it was not confirmed within `timeoutMs`.
 */
export async function waitForSignature(
  rpc: Rpc<GetSignatureStatusesApi>,
  signature: string,
  { timeoutMs = 60_000, pollMs = 1_000 } = {},
): Promise<TransactionError | null | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const {
      value: [status],
    } = await rpc.getSignatureStatuses([signature as Signature]).send()
    if (status && status.confirmationStatus !== 'processed') return status.err
    if (Date.now() >= deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}
