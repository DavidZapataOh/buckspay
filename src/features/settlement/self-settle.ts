import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget'
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  type Rpc,
  type GetAccountInfoApi,
  type GetLatestBlockhashApi,
  type GetSignatureStatusesApi,
  type SimulateTransactionApi,
  type TransactionSendingSigner,
} from '@solana/kit'
import { simulateTransaction } from '../lock/gateway-onboard'
import { waitForSignature } from '../lock/perform'
import { tokenAccountOf } from '../remote/token-account'
import type { NoteChain } from './chain'
import { settleInstructions } from './self-pay'

/** What the wallet of the person needs to settle a note by itself. */
export type SelfSettleContext = {
  rpc: Rpc<GetAccountInfoApi & GetLatestBlockhashApi & GetSignatureStatusesApi & SimulateTransactionApi>
  getTransactionSigner: (address: Address, minContextSlot: bigint) => TransactionSendingSigner
  programAddress: Address
  noteDomain: Uint8Array
  mint: Address
}

export type SelfSettleOutcome =
  | { kind: 'sent'; signature: string }
  | { kind: 'failed'; reason: 'rejected' | 'declined' | 'failed' | 'unconfirmed' | 'no_token_account' | 'too_long' }

/** Verifying the signatures dominates the cost; the settlement of one spend measured well under this. */
const COMPUTE_UNITS = 400_000

/**
 * The wallet pays the network fee and the rent of the records to credit a note the gateway did not
 * sponsor. Nothing is sent unless Solana's simulation accepts it. A note that went through other
 * phones needs more than one transaction and is left to the gateway.
 */
export async function selfSettle(
  ctx: SelfSettleContext,
  wallet: Uint8Array,
  chain: NoteChain,
): Promise<SelfSettleOutcome> {
  if (chain.spends.length !== 1) return { kind: 'failed', reason: 'too_long' }
  const { account: destination, owner: tokenProgram } = await tokenAccountOf(
    ctx.rpc,
    wallet,
    Uint8Array.from(getAddressEncoder().encode(ctx.mint)),
  )
  const { value } = await ctx.rpc.getAccountInfo(destination, { commitment: 'finalized', encoding: 'base64' }).send()
  if (value === null || value.owner !== tokenProgram) return { kind: 'failed', reason: 'no_token_account' }
  const {
    context: { slot },
    value: latestBlockhash,
  } = await ctx.rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const signer = ctx.getTransactionSigner(getAddressDecoder().decode(wallet), slot)
  const instructions = await settleInstructions(
    {
      payer: signer,
      programAddress: ctx.programAddress,
      noteDomain: ctx.noteDomain,
      mint: ctx.mint,
      tokenProgram,
      destination,
    },
    chain,
  )
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) =>
      appendTransactionMessageInstructions(
        [getSetComputeUnitLimitInstruction({ units: COMPUTE_UNITS }), ...instructions],
        m,
      ),
  )
  if (await simulateTransaction(ctx, compileTransaction(message))) return { kind: 'failed', reason: 'rejected' }
  let signature: string
  try {
    signature = getBase58Decoder().decode(await signAndSendTransactionMessageWithSigners(message))
  } catch {
    return { kind: 'failed', reason: 'declined' }
  }
  const error = await waitForSignature(ctx.rpc, signature)
  if (error === undefined) return { kind: 'failed', reason: 'unconfirmed' }
  return error === null ? { kind: 'sent', signature } : { kind: 'failed', reason: 'failed' }
}
