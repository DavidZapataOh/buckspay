import { concatBytes } from '@noble/hashes/utils.js'
import {
  type Address,
  address,
  type GetAccountInfoApi,
  type GetSignaturesForAddressApi,
  type GetTransactionApi,
  getAddressDecoder,
  getBase58Encoder,
  type Rpc,
  type Signature,
} from '@solana/kit'
import { getSettleNoteInstructionDataDecoder, SETTLE_NOTE_DISCRIMINATOR } from '@project/anchor'
import { decodeIssue } from '../../protocol'
import { ACTIVE_PROFILE } from '../../protocol/active-profile'
import { tokenAccountOf } from '../remote/token-account'

/** A settlement that credited the wallet: the amount of the `settle_note`'s own transfer and the issuer key of its issue. */
export type Incoming = { signature: string; amount: bigint; from: Uint8Array; at: number }

const PAGE = 50
const PROGRAM = address(ACTIVE_PROFILE.programId)

type Instruction = { programId: Address; data?: string; parsed?: { type: string; info: Record<string, unknown> } }

const issuerOf = (data: Uint8Array): Uint8Array | null => {
  if (!SETTLE_NOTE_DISCRIMINATOR.every((byte, i) => data[i] === byte)) return null
  try {
    const { issue } = getSettleNoteInstructionDataDecoder().decode(data)
    return decodeIssue(concatBytes(Uint8Array.from(issue), new Uint8Array(64))).message.issuer
  } catch {
    return null
  }
}

/**
 * The settlements that paid `wallet` since `since`, newest first, read only from finalized data. A payment counts by the
 * `settle_note` instruction's own inner transfer into the wallet's token account, never by the balance change of the
 * account: a transfer bundled next to someone else's settlement is not a payment from them.
 */
export async function fetchIncoming(
  rpc: Rpc<GetAccountInfoApi & GetSignaturesForAddressApi & GetTransactionApi>,
  wallet: Uint8Array,
  mint: Uint8Array,
  since?: string,
): Promise<Incoming[]> {
  const { account } = await tokenAccountOf(rpc, wallet, mint)
  const mintAddress = getAddressDecoder().decode(mint)
  const signatures = await rpc
    .getSignaturesForAddress(account, { commitment: 'finalized', limit: PAGE, until: since as Signature | undefined })
    .send()
  const found: Incoming[] = []
  for (const entry of signatures) {
    if (entry.err !== null || entry.confirmationStatus !== 'finalized') continue
    const tx = await rpc
      .getTransaction(entry.signature, {
        commitment: 'finalized',
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0,
      })
      .send()
    if (!tx || tx.meta?.err) continue
    const instructions = tx.transaction.message.instructions as unknown as Instruction[]
    instructions.forEach((instruction, index) => {
      if (instruction.programId !== PROGRAM || !instruction.data) return
      const from = issuerOf(Uint8Array.from(getBase58Encoder().encode(instruction.data)))
      if (!from) return
      const inner = (tx.meta?.innerInstructions ?? []).find((group) => group.index === index)
      let amount = 0n
      for (const step of (inner?.instructions ?? []) as unknown as Instruction[]) {
        const info = step.parsed?.info
        if (step.parsed?.type !== 'transferChecked' || !info) continue
        if (info.destination === account && info.mint === mintAddress) {
          amount += BigInt((info.tokenAmount as { amount: string }).amount)
        }
      }
      if (amount > 0n)
        found.push({ signature: entry.signature, amount, from, at: Number(entry.blockTime ?? tx.blockTime ?? 0n) })
    })
  }
  return found
}
