import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from '@solana-program/compute-budget'
import {
  AccountRole,
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getU64Encoder,
  type Instruction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { associatedTokenAddress } from '../lock/operations'
import { createTokenAccountInstruction } from '../remote/create-token-account'

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address
const TRANSFER_CHECKED = 12

export type SweepInput = {
  /** The gateway's fee payer, which pays the transaction and co-signs it. */
  gateway: Address
  /** The fresh address the rewards were claimed to, which signs. */
  fresh: Address
  /** The wallet that receives the rewards. */
  destinationOwner: Address
  mint: Address
  /** The gateway's token account for the sweep fee. */
  feeAccount: Address
  decimals: number
  amount: bigint
  fee: bigint
  /** The compute budget the gateway pins: it refuses any other. */
  computeUnitLimit: number
  computeUnitPrice: bigint
  blockhash: { blockhash: Blockhash; lastValidBlockHeight: bigint }
  /** Whether the destination's token account is created by the sweep, which the gateway pays and the fee covers. */
  createsAccount: boolean
}

function transferChecked(
  accounts: { source: Address; mint: Address; destination: Address; authority: Address },
  amount: bigint,
  decimals: number,
): Instruction {
  return {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: accounts.source, role: AccountRole.WRITABLE },
      { address: accounts.mint, role: AccountRole.READONLY },
      { address: accounts.destination, role: AccountRole.WRITABLE },
      { address: accounts.authority, role: AccountRole.READONLY_SIGNER },
    ],
    data: Uint8Array.from([TRANSFER_CHECKED, ...getU64Encoder().encode(amount), decimals]),
  } as Instruction
}

/**
 * The one transaction the gateway pays for: its pinned compute budget, the destination's token account when it is
 * created, the amount to the destination and the fee to the gateway's account, all from the fresh address's own token
 * account.
 */
export async function buildSweep(input: SweepInput) {
  const source = await associatedTokenAddress(input.fresh, input.mint, TOKEN_PROGRAM)
  const destination = await associatedTokenAddress(input.destinationOwner, input.mint, TOKEN_PROGRAM)
  const from = { source, mint: input.mint, authority: input.fresh }
  const instructions: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: input.computeUnitLimit }),
    getSetComputeUnitPriceInstruction({ microLamports: input.computeUnitPrice }),
    ...(input.createsAccount
      ? [
          await createTokenAccountInstruction(
            { address: input.gateway },
            input.destinationOwner,
            input.mint,
            TOKEN_PROGRAM,
          ),
        ]
      : []),
    transferChecked({ ...from, destination }, input.amount, input.decimals),
    transferChecked({ ...from, destination: input.feeAccount }, input.fee, input.decimals),
  ]
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(input.gateway, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(input.blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
}

/** Signs a sweep with the fresh address's key alone and encodes it, with the gateway's signature left empty, for `POST /v1/sweeps`. */
export async function signSweep(message: Awaited<ReturnType<typeof buildSweep>>, fresh: CryptoKeyPair) {
  const signed = await partiallySignTransaction([fresh], compileTransaction(message))
  return getBase64EncodedWireTransaction(signed)
}
