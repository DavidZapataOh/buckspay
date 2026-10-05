import { bytesToHex } from '@noble/hashes/utils.js'
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget'
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  isSolanaError,
  pipe,
  type ReadonlyUint8Array,
  type Rpc,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type GetLatestBlockhashApi,
  type SimulateTransactionApi,
  type Transaction,
  type TransactionError,
  type TransactionSigner,
} from '@solana/kit'
import type { Gateway } from './gateway'
import { type SponsorTerms, sponsoredTransaction } from './messages'
import type { Operation } from './operations'

/** The highest compute unit price a sponsored transaction may carry, in micro-lamports. */
export const MAX_SPONSORED_PRIORITY_FEE = 1_000_000n

/**
 * Blocks a sponsored transaction is waited for past its own RPC's newest blockhash: the gateway's
 * blockhash may come from an RPC ahead of the app's. One blockhash lifetime (150 blocks, about a
 * minute) covers an RPC that lags the gateway's by as much.
 */
export const SPONSORED_LIFETIME_MARGIN = 150n

const commitment = 'confirmed'

export type OperationContext = {
  rpc: Rpc<GetLatestBlockhashApi & SimulateTransactionApi>
  /** Has the wallet sign without sending (`useMobileWallet().signTransactions`). */
  signTransactions: (transaction: Transaction) => Promise<Transaction>
  /** The build's gateway, which pays for sponsored transactions; without one the wallet pays. */
  gateway?: Gateway
  /** The program of the build's profile. */
  programAddress: Address
}

/** Why a sponsored transaction cannot go ahead; nothing was sent and the wallet may pay instead. */
export class SponsorshipError extends Error {
  readonly reason: 'unavailable' | 'mismatch' | 'unsupported' | 'altered'
  constructor(reason: SponsorshipError['reason'], cause?: unknown) {
    super(`sponsored transaction ${reason}`, { cause })
    this.reason = reason
  }
}

const sameBytes = (a: ReadonlyUint8Array, b: ReadonlyUint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

/**
 * Asks the gateway to pay for `operation` and returns the app's own build of it, once the gateway's
 * transaction is that build byte for byte: the gateway chooses only who pays, the blockhash, a
 * compute unit limit within the operation's ceiling and a capped price, and the fee is the one the
 * user was quoted. How long the transaction can land is read from the app's own RPC after the
 * gateway chose its blockhash, plus `SPONSORED_LIFETIME_MARGIN`, so a gateway cannot make the app
 * wait longer than that.
 */
export async function prepareSponsored(ctx: OperationContext, operation: Operation) {
  if (!ctx.gateway) throw new SponsorshipError('unavailable')
  let prepared
  try {
    prepared = await ctx.gateway.prepare(operation.kind, operation.request)
  } catch (error) {
    throw new SponsorshipError('unavailable', error)
  }
  const { value: latest } = await ctx.rpc.getLatestBlockhash({ commitment }).send()
  const lastValidBlockHeight = latest.lastValidBlockHeight + SPONSORED_LIFETIME_MARGIN
  let terms: SponsorTerms
  let expected: Transaction
  let offered: Transaction
  try {
    terms = {
      programAddress: ctx.programAddress,
      feePayer: address(prepared.feePayer),
      blockhash: prepared.blockhash,
      lastValidBlockHeight,
      computeUnitLimit: prepared.computeUnitLimit,
      computeUnitPrice: BigInt(prepared.computeUnitPrice),
    }
    expected = sponsoredTransaction(
      terms,
      await operation.build(
        { wallet: createNoopSigner(operation.wallet), payer: createNoopSigner(terms.feePayer) },
        true,
      ),
    )
    offered = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction))
  } catch (error) {
    throw new SponsorshipError('mismatch', error)
  }
  if (
    terms.feePayer === operation.wallet ||
    terms.computeUnitPrice > MAX_SPONSORED_PRIORITY_FEE ||
    !Number.isInteger(terms.computeUnitLimit) ||
    terms.computeUnitLimit <= 0 ||
    terms.computeUnitLimit > operation.ceiling ||
    prepared.sponsorFee !== operation.expectedFee ||
    !sameBytes(offered.messageBytes, expected.messageBytes)
  ) {
    throw new SponsorshipError('mismatch')
  }
  return { transaction: expected, lastValidBlockHeight }
}

export type SponsoredTransaction = Awaited<ReturnType<typeof prepareSponsored>>

/** The error Solana would fail a transaction with, without its signatures, if any. */
export async function simulateTransaction(
  { rpc }: Pick<OperationContext, 'rpc'>,
  transaction: Transaction,
): Promise<TransactionError | null> {
  const { value } = await rpc
    .simulateTransaction(getBase64EncodedWireTransaction(transaction), {
      commitment,
      encoding: 'base64',
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send()
  return value.err
}

/**
 * Has the wallet sign the sponsored transaction without sending it, and refuses anything but those
 * exact bytes with the wallet's signature. An answer that does not decode as a transaction with the
 * message's signer slots, such as one signature where two are required, is refused the same way.
 */
export async function signSponsored(
  ctx: Pick<OperationContext, 'signTransactions'>,
  wallet: Address,
  { transaction }: SponsoredTransaction,
): Promise<Transaction> {
  let signed
  try {
    signed = await ctx.signTransactions(transaction)
  } catch (error) {
    // Signing reads nothing from Solana: a Solana error here is the wallet's answer failing to decode.
    if (isSolanaError(error)) throw new SponsorshipError('altered', error)
    throw error
  }
  if (!sameBytes(signed.messageBytes, transaction.messageBytes) || !signed.signatures[wallet]) {
    throw new SponsorshipError('altered')
  }
  return signed
}

/** Hands the wallet-signed transaction to the gateway, which adds its signature and sends it. */
export async function submitSponsored(
  { gateway }: Pick<OperationContext, 'gateway'>,
  operation: Operation,
  signed: Transaction,
) {
  if (!gateway) throw new SponsorshipError('unavailable')
  const { signature } = await gateway.submit(operation.kind, {
    key: bytesToHex(Uint8Array.from(operation.key)),
    transaction: getBase64EncodedWireTransaction(signed),
  })
  return signature
}

/**
 * The same operation paid by the wallet: it is the fee payer and lends the rent, and owes no
 * sponsor fee. Its compute unit limit is the operation's ceiling, which costs nothing extra without
 * a priority fee.
 */
export async function selfPaidMessage(
  operation: Operation,
  signer: TransactionSigner,
  latestBlockhash: Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0],
) {
  const instructions = await operation.build({ wallet: signer, payer: signer }, false)
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) =>
      appendTransactionMessageInstructions(
        [getSetComputeUnitLimitInstruction({ units: operation.ceiling }), ...instructions],
        m,
      ),
  )
}
