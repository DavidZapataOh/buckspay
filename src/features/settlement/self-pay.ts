import {
  findDevicePda,
  findEscrowPda,
  findLedgerPda,
  findLockPda,
  getReclaimOutputInstruction,
  getRecordPrefixInstruction,
  getSettleNoteInstruction,
} from '@project/anchor'
import {
  AccountRole,
  type Address,
  address,
  getAddressDecoder,
  getAddressEncoder,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit'
import {
  type ChainEntry,
  type ChainLink,
  type ConsumedOutput,
  encodeIssueBody,
  ProtocolError,
  reclaimEnvelope,
  recordAddress,
  type Output,
  walkChain,
  writeVerification,
} from '../../protocol'
import type { NoteChain } from './chain'

/** The program the transaction asks to verify the device signatures. */
export const SECP256R1_PROGRAM = address('Secp256r1SigVerify1111111111111111111111111')

/** What a wallet that pays for the settlement itself names besides the chain. */
export type SelfPay = {
  /** The wallet: it pays the fee and the rent of the records, returned when they close. */
  payer: TransactionSigner
  programAddress: Address
  noteDomain: Uint8Array
  reclaimDomain: Uint8Array
  mint: Address
  tokenProgram: Address
  /** A token account of the mint: the payee's for a settlement, the wallet bound to the owner's for a reclaim. */
  destination: Address
}

const writable = (address: Address) => ({ address, role: AccountRole.WRITABLE })

/**
 * The instruction that has the precompile verify the messages from `covered` on, in the layout the
 * program reads, or none when records already on chain vouch for all of them.
 */
function verification(entries: ChainEntry[], covered: number): Instruction[] {
  const rest = entries.slice(covered)
  if (rest.length === 0) return []
  const data = writeVerification(
    rest.map(({ key, envelope }) => ({ key, message: envelope })),
    rest.map(({ signature }) => signature),
  )
  return [{ programAddress: SECP256R1_PROGRAM, accounts: [], data }]
}

function recordAccounts(program: Uint8Array, outputs: Uint8Array[]): Address[] {
  return outputs.map((output) => {
    const record = recordAddress(program, output)
    if (!record) throw new ProtocolError('Unrecordable')
    return getAddressDecoder().decode(record)
  })
}

const issueOutput = (last: Output[], consumed: ConsumedOutput[]) =>
  consumed.length === 0 ? [last[0].id] : consumed.map(({ output }) => output)

async function accounts(pay: SelfPay, chain: NoteChain) {
  const { issuer, lockSeq } = chain.issue.message
  const [lock] = await findLockPda(issuer, lockSeq, pay.programAddress)
  const [[ledger], [escrow]] = await Promise.all([
    findLedgerPda({ lock }, { programAddress: pay.programAddress }),
    findEscrowPda({ lock }, { programAddress: pay.programAddress }),
  ])
  return { lock, ledger, escrow, program: getAddressEncoder().encode(pay.programAddress) as Uint8Array }
}

const toLinks = (links: ChainLink[]) => links.map(({ input, body }) => ({ input, body }))

/**
 * `[secp256r1 verification, settle_note]` for the wallet to sign: one spend fits one transaction,
 * with the signatures from `covered` on when records vouch for the earlier ones.
 */
export async function settleInstructions(pay: SelfPay, chain: NoteChain, covered = 0): Promise<Instruction[]> {
  const walk = walkChain(pay.noteDomain, chain.issue, chain.spends)
  const { lock, ledger, escrow, program } = await accounts(pay, chain)
  const settle = getSettleNoteInstruction(
    {
      payer: pay.payer,
      lock,
      ledger,
      escrow,
      mint: pay.mint,
      destination: pay.destination,
      tokenProgram: pay.tokenProgram,
      issue: encodeIssueBody(chain.issue.message),
      spends: toLinks(walk.links),
    },
    { programAddress: pay.programAddress },
  )
  const records = recordAccounts(program, issueOutput(walk.last, walk.consumed)).map(writable)
  return [...verification(walk.entries, covered), { ...settle, accounts: [...settle.accounts, ...records] }]
}

/**
 * `[secp256r1 verification, record_prefix]`: records the outputs a chain consumed without paying
 * anyone, so that a chain of two spends settles in two transactions a wallet can sign.
 */
export async function recordPrefixInstructions(pay: SelfPay, chain: NoteChain, covered = 0): Promise<Instruction[]> {
  if (chain.spends.length === 0) throw new ProtocolError('Length')
  const walk = walkChain(pay.noteDomain, chain.issue, chain.spends)
  const { lock, program } = await accounts(pay, chain)
  const record = getRecordPrefixInstruction(
    { payer: pay.payer, lock, issue: encodeIssueBody(chain.issue.message), spends: toLinks(walk.links) },
    { programAddress: pay.programAddress },
  )
  const records = recordAccounts(program, issueOutput(walk.last, walk.consumed)).map(writable)
  return [...verification(walk.entries, covered), { ...record, accounts: [...record.accounts, ...records] }]
}

/**
 * `[secp256r1 verification, reclaim_output]` taking back output `which` of the last message of
 * `chain`, whose owner `owner` signed the reclaim (`signature`, with `deadline`).
 */
export async function reclaimInstructions(
  pay: SelfPay,
  chain: NoteChain,
  owner: Uint8Array,
  which: 0 | 1,
  deadline: number,
  signature: Uint8Array,
): Promise<Instruction[]> {
  const walk = walkChain(pay.noteDomain, chain.issue, chain.spends)
  const output = walk.last[which]
  if (!output || output.owner.type !== 'device') throw new ProtocolError('Owner')
  const { lock, ledger, escrow, program } = await accounts(pay, chain)
  const [device] = await findDevicePda(owner, pay.programAddress)
  const entries = [
    ...walk.entries,
    { key: owner, envelope: reclaimEnvelope(pay.reclaimDomain, output.id, deadline), signature },
  ]
  const reclaim = getReclaimOutputInstruction(
    {
      payer: pay.payer,
      device,
      lock,
      ledger,
      escrow,
      mint: pay.mint,
      destination: pay.destination,
      tokenProgram: pay.tokenProgram,
      owner,
      issue: encodeIssueBody(chain.issue.message),
      spends: toLinks(walk.links),
      which,
      deadline,
    },
    { programAddress: pay.programAddress },
  )
  const records = recordAccounts(program, [...walk.consumed.map(({ output }) => output), output.id]).map(writable)
  return [...verification(entries, 0), { ...reclaim, accounts: [...reclaim.accounts, ...records] }]
}
