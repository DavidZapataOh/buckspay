import { bytesToHex } from '@noble/hashes/utils.js'
import {
  findDevicePda,
  getDeviceSize,
  getRegisterDeviceInstruction,
  registerDeviceComputeUnitLimit,
} from '@project/anchor'
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget'
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  type GetBalanceApi,
  type GetFeeForMessageApi,
  type GetLatestBlockhashApi,
  type GetMinimumBalanceForRentExemptionApi,
  pipe,
  type ReadonlyUint8Array,
  type Rpc,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  type SimulateTransactionApi,
  type Transaction,
  type TransactionError,
  type TransactionMessageBytesBase64,
  type TransactionSendingSigner,
} from '@solana/kit'
import { signDeviceBinding } from '../../keys'
import { getSecp256r1VerifyInstruction } from '../../solana/secp256r1'
import type { Gateway } from './gateway'

export type RegisterDeviceContext = {
  rpc: Rpc<
    GetBalanceApi &
      GetFeeForMessageApi &
      GetLatestBlockhashApi &
      GetMinimumBalanceForRentExemptionApi &
      SimulateTransactionApi
  >
  /** The wallet's sign-and-send signer (`useMobileWallet().getTransactionSigner`). */
  getTransactionSigner: (address: Address, minContextSlot: bigint) => TransactionSendingSigner
  /** Has the wallet sign without sending (`useMobileWallet().signTransactions`). */
  signTransactions: (transaction: Transaction) => Promise<Transaction>
  /** The build's gateway, which pays for registrations; without one the wallet pays. */
  gateway?: Gateway
}

/** What registering costs (the device account's rent and the network fee) and what the wallet holds. */
export type RegistrationQuote = { balance: bigint; cost: bigint }

/** The highest compute unit price a sponsored registration may carry, in micro-lamports. */
export const MAX_SPONSORED_PRIORITY_FEE = 1_000_000n

/**
 * Blocks a sponsored registration is waited for past its own RPC's newest blockhash: the gateway's
 * blockhash may come from an RPC ahead of the app's. One blockhash lifetime (150 blocks, about a
 * minute) covers an RPC that lags the gateway's by as much.
 */
export const SPONSORED_LIFETIME_MARGIN = 150n

const commitment = 'confirmed'

/**
 * Signs this device key's binding to `wallet` and builds `[compute unit limit, secp256r1
 * verification, register_device]`, the transaction the wallet signs, pays for and sends when it
 * registers without a sponsor.
 */
export async function buildRegistration(wallet: Address, { rpc, getTransactionSigner }: RegisterDeviceContext) {
  const binding = await signDeviceBinding(wallet)
  const [device, bump] = await findDevicePda(binding.key)
  const {
    context: { slot },
    value: latestBlockhash,
  } = await rpc.getLatestBlockhash({ commitment }).send()
  const signer = getTransactionSigner(wallet, slot)
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: registerDeviceComputeUnitLimit(bump) }),
          getSecp256r1VerifyInstruction({
            publicKey: binding.key,
            signature: binding.signature,
            message: binding.envelope,
          }),
          getRegisterDeviceInstruction({ wallet: signer, payer: signer, device, key: binding.key }),
        ],
        m,
      ),
  )
  return {
    binding,
    bump,
    device,
    key: binding.key,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    message,
    wallet,
  }
}

export type Registration = Awaited<ReturnType<typeof buildRegistration>>

/** Reads the wallet's balance, the device account's rent and the fee of a built registration. */
export async function quoteRegistration(
  { rpc }: RegisterDeviceContext,
  { message, wallet }: Registration,
): Promise<RegistrationQuote> {
  const messageBytes = getBase64Decoder().decode(
    compileTransaction(message).messageBytes,
  ) as TransactionMessageBytesBase64
  const [{ value: balance }, rent, { value: fee }] = await Promise.all([
    rpc.getBalance(wallet, { commitment }).send(),
    rpc.getMinimumBalanceForRentExemption(BigInt(getDeviceSize()), { commitment }).send(),
    rpc.getFeeForMessage(messageBytes, { commitment }).send(),
  ])
  if (fee === null) throw new Error('Solana no longer knows the registration’s blockhash.')
  return { balance, cost: rent + fee }
}

/** The error Solana would fail a transaction with, without its signatures, if any. */
async function simulate({ rpc }: RegisterDeviceContext, transaction: Transaction): Promise<TransactionError | null> {
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

/** The error Solana would fail a built registration with, if any. */
export const simulateRegistration = (ctx: RegisterDeviceContext, { message }: Registration) =>
  simulate(ctx, compileTransaction(message))

/** Has the wallet sign, pay for and send a built registration. */
export const sendRegistration = ({ message }: Registration) => signAndSendTransactionMessageWithSigners(message)

/** What the gateway decides in a sponsored registration: who pays, its blockhash and its price. */
export type Sponsor = {
  feePayer: Address
  blockhash: string
  lastValidBlockHeight: bigint
  computeUnitPrice: bigint
}

/**
 * The sponsored registration `[compute unit limit, compute unit price, secp256r1 verification,
 * register_device]`: `sponsor` pays the fee and the rent, and the wallet signs only as `wallet`.
 * The app builds it itself and lets the wallet sign nothing else.
 */
export function buildSponsoredTransaction(
  { binding, bump, device, wallet }: Pick<Registration, 'binding' | 'bump' | 'device' | 'wallet'>,
  sponsor: Sponsor,
): Transaction {
  const payer = createNoopSigner(sponsor.feePayer)
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(sponsor.feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash(sponsor.blockhash), lastValidBlockHeight: sponsor.lastValidBlockHeight },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: registerDeviceComputeUnitLimit(bump) }),
          getSetComputeUnitPriceInstruction({ microLamports: sponsor.computeUnitPrice }),
          getSecp256r1VerifyInstruction({
            publicKey: binding.key,
            signature: binding.signature,
            message: binding.envelope,
          }),
          getRegisterDeviceInstruction({ wallet: createNoopSigner(wallet), payer, device, key: binding.key }),
        ],
        m,
      ),
  )
  return compileTransaction(message)
}

/** Why a sponsored registration cannot go ahead; nothing was sent and the wallet may pay instead. */
export class SponsorshipError extends Error {
  readonly reason: 'unavailable' | 'mismatch' | 'unsupported' | 'altered'
  constructor(reason: SponsorshipError['reason'], cause?: unknown) {
    super(`sponsored registration ${reason}`, { cause })
    this.reason = reason
  }
}

const sameBytes = (a: ReadonlyUint8Array, b: ReadonlyUint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

/**
 * Asks the gateway to pay for `registration` and returns the app's own build of it, once the
 * gateway's transaction is that build byte for byte: the gateway chooses only who pays, the
 * blockhash and a capped compute unit price. How long the registration can land is read from the
 * app's own RPC after the gateway chose its blockhash, plus `SPONSORED_LIFETIME_MARGIN`, so a
 * gateway cannot make the app wait longer than that.
 */
export async function prepareSponsoredRegistration(ctx: RegisterDeviceContext, registration: Registration) {
  if (!ctx.gateway) throw new SponsorshipError('unavailable')
  const { binding, wallet } = registration
  let prepared
  try {
    prepared = await ctx.gateway.prepare({
      wallet,
      key: bytesToHex(Uint8Array.from(binding.key)),
      signature: bytesToHex(Uint8Array.from(binding.signature)),
    })
  } catch (error) {
    throw new SponsorshipError('unavailable', error)
  }
  const { value: latest } = await ctx.rpc.getLatestBlockhash({ commitment }).send()
  const lastValidBlockHeight = latest.lastValidBlockHeight + SPONSORED_LIFETIME_MARGIN
  let sponsor: Sponsor
  let expected: Transaction
  let offered: Transaction
  try {
    sponsor = {
      feePayer: address(prepared.feePayer),
      blockhash: prepared.blockhash,
      lastValidBlockHeight,
      computeUnitPrice: BigInt(prepared.computeUnitPrice),
    }
    expected = buildSponsoredTransaction(registration, sponsor)
    offered = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction))
  } catch (error) {
    throw new SponsorshipError('mismatch', error)
  }
  if (
    sponsor.feePayer === wallet ||
    sponsor.computeUnitPrice > MAX_SPONSORED_PRIORITY_FEE ||
    !sameBytes(offered.messageBytes, expected.messageBytes)
  ) {
    throw new SponsorshipError('mismatch')
  }
  return { transaction: expected, lastValidBlockHeight: sponsor.lastValidBlockHeight }
}

export type SponsoredRegistration = Awaited<ReturnType<typeof prepareSponsoredRegistration>>

/** The error Solana would fail a sponsored registration with, if any. */
export const simulateSponsoredRegistration = (ctx: RegisterDeviceContext, { transaction }: SponsoredRegistration) =>
  simulate(ctx, transaction)

/**
 * Has the wallet sign the sponsored registration without sending it, and refuses anything but those
 * exact bytes with the wallet's signature.
 */
export async function signSponsoredRegistration(
  ctx: RegisterDeviceContext,
  wallet: Address,
  { transaction }: SponsoredRegistration,
): Promise<Transaction> {
  const signed = await ctx.signTransactions(transaction)
  if (!sameBytes(signed.messageBytes, transaction.messageBytes) || !signed.signatures[wallet]) {
    throw new SponsorshipError('altered')
  }
  return signed
}

/** Hands the wallet-signed registration to the gateway, which adds its signature and sends it. */
export async function submitSponsoredRegistration(
  { gateway }: RegisterDeviceContext,
  { key }: Registration,
  signed: Transaction,
) {
  if (!gateway) throw new SponsorshipError('unavailable')
  const { signature } = await gateway.submit({
    key: bytesToHex(Uint8Array.from(key)),
    transaction: getBase64EncodedWireTransaction(signed),
  })
  return signature
}
