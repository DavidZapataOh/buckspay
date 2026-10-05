import {
  findEscrowPda,
  findLedgerPda,
  findLockPda,
  findDevicePda,
  findRotationPda,
  getCancelWalletRotationInstruction,
  getCreateLockInstruction,
  getRegisterDeviceInstruction,
  getRequestWalletRotationInstruction,
  getWithdrawLockInstruction,
} from '@project/anchor'
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget'
import {
  type Address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  type Instruction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Transaction,
  type TransactionSigner,
} from '@solana/kit'
import { getSecp256r1VerifyInstruction } from '../../solana/secp256r1'

/** What the gateway decides in a sponsored transaction: who pays, its blockhash, limit and price. */
export type SponsorTerms = {
  programAddress: Address
  feePayer: Address
  blockhash: string
  lastValidBlockHeight: bigint
  computeUnitLimit: number
  computeUnitPrice: bigint
}

/** A signature of the device key over an envelope, as the secp256r1 program verifies it. */
export type DeviceSignature = { key: Uint8Array; signature: Uint8Array; envelope: Uint8Array }

/** A lock to create: the accounts that fund it, its amounts and, once, a fee to the sponsor. */
export type LockParams = {
  wallet: Address
  key: Uint8Array
  funder: Address
  mint: Address
  tokenProgram: Address
  bond: bigint
  backing: bigint
  lockUntil: number
  sponsorFee?: bigint
  sponsorToken?: Address
}

export type OnboardParams = LockParams & { binding: DeviceSignature }

export type WithdrawalParams = {
  wallet: Address
  key: Uint8Array
  rentReceiver: Address
  lockSeq: number
  mint: Address
  tokenProgram: Address
  destination: Address
}

export type RotationRequestParams = { newWallet: Address; key: Uint8Array } & Pick<
  DeviceSignature,
  'signature' | 'envelope'
>

export type RotationCancelParams = { wallet: Address; key: Uint8Array; rentReceiver: Address }

/** Who signs a transaction's instructions: the wallet, and whoever pays and lends the rent. */
export type Signers = { wallet: TransactionSigner; payer: TransactionSigner }

const noop = (address: Address) => createNoopSigner(address)

async function createLockInstruction(
  programAddress: Address,
  { wallet, payer }: Signers,
  params: LockParams,
  lockSeq: number,
) {
  const [lock] = await findLockPda(params.key, lockSeq, programAddress)
  const [ledger] = await findLedgerPda({ lock }, { programAddress })
  const [escrow] = await findEscrowPda({ lock }, { programAddress })
  const [device] = await findDevicePda(params.key, programAddress)
  return getCreateLockInstruction(
    {
      wallet,
      payer,
      device,
      lock,
      ledger,
      escrow,
      mint: params.mint,
      funder: params.funder,
      sponsorToken: params.sponsorToken,
      tokenProgram: params.tokenProgram,
      key: params.key,
      lockSeq,
      bond: params.bond,
      backing: params.backing,
      lockUntil: params.lockUntil,
      sponsorFee: params.sponsorFee ?? 0n,
    },
    { programAddress },
  )
}

/** `[secp256r1 verification of the binding, register_device, create_lock]`: a key's first lock. */
export async function onboardInstructions(
  programAddress: Address,
  signers: Signers,
  params: OnboardParams,
): Promise<Instruction[]> {
  const { key } = params
  const [device] = await findDevicePda(key, programAddress)
  return [
    getSecp256r1VerifyInstruction({
      publicKey: params.binding.key,
      signature: params.binding.signature,
      message: params.binding.envelope,
    }),
    getRegisterDeviceInstruction({ ...signers, device, key }, { programAddress }),
    await createLockInstruction(programAddress, signers, params, 0),
  ]
}

/** `create_lock` of the key's `lockSeq`-th lock. */
export async function lockInstructions(
  programAddress: Address,
  signers: Signers,
  params: LockParams & { lockSeq: number },
): Promise<Instruction[]> {
  return [await createLockInstruction(programAddress, signers, params, params.lockSeq)]
}

export async function withdrawalInstructions(
  programAddress: Address,
  wallet: TransactionSigner,
  params: WithdrawalParams,
): Promise<Instruction[]> {
  const [lock] = await findLockPda(params.key, params.lockSeq, programAddress)
  return [
    getWithdrawLockInstruction(
      {
        wallet,
        device: (await findDevicePda(params.key, programAddress))[0],
        lock,
        ledger: (await findLedgerPda({ lock }, { programAddress }))[0],
        escrow: (await findEscrowPda({ lock }, { programAddress }))[0],
        mint: params.mint,
        destination: params.destination,
        rentReceiver: params.rentReceiver,
        tokenProgram: params.tokenProgram,
        key: params.key,
        lockSeq: params.lockSeq,
      },
      { programAddress },
    ),
  ]
}

/** `[secp256r1 verification of the rotation, request_wallet_rotation]`. */
export async function rotationRequestInstructions(
  programAddress: Address,
  { wallet: newWallet, payer }: Signers,
  params: RotationRequestParams,
): Promise<Instruction[]> {
  return [
    getSecp256r1VerifyInstruction({
      publicKey: params.key,
      signature: params.signature,
      message: params.envelope,
    }),
    getRequestWalletRotationInstruction(
      {
        newWallet,
        payer,
        device: (await findDevicePda(params.key, programAddress))[0],
        rotation: (await findRotationPda(params.key, programAddress))[0],
        key: params.key,
      },
      { programAddress },
    ),
  ]
}

export async function rotationCancelInstructions(
  programAddress: Address,
  wallet: TransactionSigner,
  params: RotationCancelParams,
): Promise<Instruction[]> {
  return [
    getCancelWalletRotationInstruction(
      {
        wallet,
        device: (await findDevicePda(params.key, programAddress))[0],
        rotation: (await findRotationPda(params.key, programAddress))[0],
        rentReceiver: params.rentReceiver,
        key: params.key,
      },
      { programAddress },
    ),
  ]
}

/**
 * `[set compute unit limit, set compute unit price, ...instructions]` as a version 0 message without
 * lookup tables, paid by the sponsor: the exact transaction the gateway prepares.
 */
export function sponsoredTransaction(terms: SponsorTerms, instructions: Instruction[]): Transaction {
  return compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(terms.feePayer, m),
      (m) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash(terms.blockhash), lastValidBlockHeight: terms.lastValidBlockHeight },
          m,
        ),
      (m) =>
        appendTransactionMessageInstructions(
          [
            getSetComputeUnitLimitInstruction({ units: terms.computeUnitLimit }),
            getSetComputeUnitPriceInstruction({ microLamports: terms.computeUnitPrice }),
            ...instructions,
          ],
          m,
        ),
    ),
  )
}

const sponsored = (terms: SponsorTerms, wallet: Address): Signers => ({
  wallet: noop(wallet),
  payer: noop(terms.feePayer),
})

export async function buildOnboardTransaction(terms: SponsorTerms, params: OnboardParams) {
  return sponsoredTransaction(
    terms,
    await onboardInstructions(terms.programAddress, sponsored(terms, params.wallet), params),
  )
}

export async function buildLockTransaction(terms: SponsorTerms, params: LockParams & { lockSeq: number }) {
  return sponsoredTransaction(
    terms,
    await lockInstructions(terms.programAddress, sponsored(terms, params.wallet), params),
  )
}

export async function buildWithdrawalTransaction(terms: SponsorTerms, params: WithdrawalParams) {
  return sponsoredTransaction(terms, await withdrawalInstructions(terms.programAddress, noop(params.wallet), params))
}

export async function buildRotationRequestTransaction(terms: SponsorTerms, params: RotationRequestParams) {
  return sponsoredTransaction(
    terms,
    await rotationRequestInstructions(terms.programAddress, sponsored(terms, params.newWallet), params),
  )
}

export async function buildRotationCancelTransaction(terms: SponsorTerms, params: RotationCancelParams) {
  return sponsoredTransaction(
    terms,
    await rotationCancelInstructions(terms.programAddress, noop(params.wallet), params),
  )
}
