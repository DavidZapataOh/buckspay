import { bytesToHex } from '@noble/hashes/utils.js'
import { type Address, getAddressEncoder, getProgramDerivedAddress, type Instruction } from '@solana/kit'
import type { OperationKind } from './gateway'
import {
  type LockParams,
  lockInstructions,
  onboardInstructions,
  type OnboardParams,
  rotationCancelInstructions,
  type RotationCancelParams,
  type Signers,
  withdrawalInstructions,
  type WithdrawalParams,
} from './messages'

/** The most compute units a sponsored operation may be given, as the gateway caps them. */
export const COMPUTE_UNIT_CEILING = {
  onboard: 100_000,
  lock: 60_000,
  withdrawal: 40_000,
  'rotation-request': 40_000,
  'rotation-cancel': 40_000,
} as const satisfies Record<OperationKind, number>

/**
 * A transaction the gateway can pay for and the wallet can pay for itself: what to ask the gateway,
 * the fee it was quoted, and how the app builds the instructions for whoever signs and pays.
 */
export type Operation = {
  kind: OperationKind
  /** The device key, which names the gateway's pending entry. */
  key: Uint8Array
  /** The wallet that signs. */
  wallet: Address
  /** The body of the gateway's prepare request. */
  request: Record<string, unknown>
  /** The fee in the mint's base units the user was quoted; the transaction carries no other. */
  expectedFee: bigint
  ceiling: number
  /** The token account that receives the fee of `payer`, if the operation can carry one. */
  sponsorToken(payer: Address): Promise<Address | undefined>
  /** The instructions; `sponsored` keeps the quoted fee, a wallet paying for itself owes none. */
  build(signers: Signers, sponsored: boolean): Promise<Instruction[]>
}

const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' as Address

/** The associated token account of `owner` for `mint` under `tokenProgram`. */
export async function associatedTokenAddress(owner: Address, mint: Address, tokenProgram: Address) {
  const encoder = getAddressEncoder()
  const [address] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [encoder.encode(owner), encoder.encode(tokenProgram), encoder.encode(mint)],
  })
  return address
}

const hex = bytesToHex
const noToken = async () => undefined

export function onboardOperation(
  params: Omit<OnboardParams, 'key'> & { programAddress: Address; sponsorFee?: bigint },
): Operation {
  const { programAddress, binding } = params
  const fee = params.sponsorFee ?? 0n
  return {
    kind: 'onboard',
    key: binding.key,
    wallet: params.wallet,
    request: {
      wallet: params.wallet,
      key: hex(binding.key),
      funder: params.funder,
      bond: params.bond.toString(),
      backing: params.backing.toString(),
      lockUntil: params.lockUntil,
      signature: hex(binding.signature),
    },
    expectedFee: fee,
    ceiling: COMPUTE_UNIT_CEILING.onboard,
    sponsorToken: (payer) =>
      fee > 0n ? associatedTokenAddress(payer, params.mint, params.tokenProgram) : Promise.resolve(undefined),
    async build(signers, sponsored) {
      const owed = sponsored ? fee : 0n
      const sponsorToken = owed > 0n ? await this.sponsorToken(signers.payer.address) : undefined
      return onboardInstructions(programAddress, signers, {
        ...params,
        key: binding.key,
        sponsorFee: owed,
        sponsorToken,
      })
    },
  }
}

export function lockOperation(params: LockParams & { programAddress: Address; lockSeq: number }): Operation {
  return {
    kind: 'lock',
    key: params.key,
    wallet: params.wallet,
    request: {
      wallet: params.wallet,
      key: hex(params.key),
      funder: params.funder,
      bond: params.bond.toString(),
      backing: params.backing.toString(),
      lockUntil: params.lockUntil,
    },
    expectedFee: 0n,
    ceiling: COMPUTE_UNIT_CEILING.lock,
    sponsorToken: noToken,
    build: (signers) =>
      lockInstructions(params.programAddress, signers, { ...params, sponsorFee: 0n, sponsorToken: undefined }),
  }
}

export function withdrawalOperation(params: WithdrawalParams & { programAddress: Address }): Operation {
  return {
    kind: 'withdrawal',
    key: params.key,
    wallet: params.wallet,
    request: {
      wallet: params.wallet,
      key: hex(params.key),
      lockSeq: params.lockSeq,
      destination: params.destination,
    },
    expectedFee: 0n,
    ceiling: COMPUTE_UNIT_CEILING.withdrawal,
    sponsorToken: noToken,
    build: (signers) => withdrawalInstructions(params.programAddress, signers.wallet, params),
  }
}

export function rotationCancelOperation(params: RotationCancelParams & { programAddress: Address }): Operation {
  return {
    kind: 'rotation-cancel',
    key: params.key,
    wallet: params.wallet,
    request: { wallet: params.wallet, key: hex(params.key) },
    expectedFee: 0n,
    ceiling: COMPUTE_UNIT_CEILING['rotation-cancel'],
    sponsorToken: noToken,
    build: (signers) => rotationCancelInstructions(params.programAddress, signers.wallet, params),
  }
}
