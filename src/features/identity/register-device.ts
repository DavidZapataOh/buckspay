import {
  findDevicePda,
  getDeviceSize,
  getRegisterDeviceInstruction,
  registerDeviceComputeUnitLimit,
} from '@project/anchor'
import { getSetComputeUnitLimitInstruction } from '@solana-program/compute-budget'
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  type GetBalanceApi,
  type GetFeeForMessageApi,
  type GetLatestBlockhashApi,
  type GetMinimumBalanceForRentExemptionApi,
  pipe,
  type Rpc,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  type SimulateTransactionApi,
  type TransactionError,
  type TransactionMessageBytesBase64,
  type TransactionSendingSigner,
} from '@solana/kit'
import { signDeviceBinding } from '../../keys'
import { getSecp256r1VerifyInstruction } from '../../solana/secp256r1'

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
}

/** What registering costs (the device account's rent and the network fee) and what the wallet holds. */
export type RegistrationQuote = { balance: bigint; cost: bigint }

const commitment = 'confirmed'

/**
 * Signs this device key's binding to `wallet` and builds `[compute unit limit, secp256r1
 * verification, register_device]`, the one transaction the wallet signs, pays for and sends.
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
          getRegisterDeviceInstruction({ wallet: signer, device, key: binding.key }),
        ],
        m,
      ),
  )
  return { key: binding.key, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight, message, wallet }
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

/** The error Solana would fail a built registration with, without its signatures, if any. */
export async function simulateRegistration(
  { rpc }: RegisterDeviceContext,
  { message }: Registration,
): Promise<TransactionError | null> {
  const { value } = await rpc
    .simulateTransaction(getBase64EncodedWireTransaction(compileTransaction(message)), {
      commitment,
      encoding: 'base64',
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send()
  return value.err
}

/** Has the wallet sign, pay for and send a built registration. */
export const sendRegistration = ({ message }: Registration) => signAndSendTransactionMessageWithSigners(message)
