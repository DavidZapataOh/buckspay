import {
  AccountRole,
  type Address,
  appendTransactionMessageInstruction,
  createTransactionMessage,
  getBase58Decoder,
  type GetLatestBlockhashApi,
  type Instruction,
  pipe,
  type Rpc,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  type TransactionSendingSigner,
} from '@solana/kit'
import { associatedTokenAddress } from '../lock/operations'

const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' as Address
const SYSTEM_PROGRAM = '11111111111111111111111111111111' as Address
const CREATE_IDEMPOTENT = Uint8Array.of(1)

/** `CreateIdempotent` of the associated token program: the wallet pays the rent and owns the account. */
export async function createTokenAccountInstruction(
  payer: Pick<TransactionSendingSigner, 'address'>,
  wallet: Address,
  mint: Address,
  tokenProgram: Address,
): Promise<Instruction> {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    accounts: [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer as TransactionSendingSigner },
      { address: await associatedTokenAddress(wallet, mint, tokenProgram), role: AccountRole.WRITABLE },
      { address: wallet, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      { address: tokenProgram, role: AccountRole.READONLY },
    ],
    data: CREATE_IDEMPOTENT,
  } as Instruction
}

/** The wallet signs, pays for and sends the creation of its own USDC account; the gateway creates nothing. */
export async function createTokenAccount(
  rpc: Rpc<GetLatestBlockhashApi>,
  getTransactionSigner: (address: Address, minContextSlot: bigint) => TransactionSendingSigner,
  wallet: Address,
  mint: Address,
  tokenProgram: Address,
): Promise<string> {
  const {
    context: { slot },
    value: latestBlockhash,
  } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send()
  const signer = getTransactionSigner(wallet, slot)
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    async (m) =>
      appendTransactionMessageInstruction(await createTokenAccountInstruction(signer, wallet, mint, tokenProgram), m),
  )
  return getBase58Decoder().decode(await signAndSendTransactionMessageWithSigners(await message))
}
