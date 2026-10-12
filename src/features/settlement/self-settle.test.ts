import { hexToBytes } from '@noble/hashes/utils.js'
import {
  address,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  type Address,
  type TransactionSendingSigner,
} from '@solana/kit'
import { describe, expect, it, vi } from 'vitest'
import vectors from '../../../anchor/crates/protocol/tests/vectors/v1.json'
import { decodeIssue, decodeSpend } from '../../protocol'
import { associatedTokenAddress } from '../lock/operations'
import { type NoteChain } from './chain'
import { selfSettle, type SelfSettleContext } from './self-settle'

const program = hexToBytes(vectors.record_addresses.program_id)
const mint = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
const tokenProgram = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const wallet = address('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS')
const walletBytes = Uint8Array.from(getAddressEncoder().encode(wallet))
const settlement = vectors.settlements.find(({ name }) => name === 'authority_redemption')!
const through = vectors.settlements.find(({ name }) => name === 'unbonded_receiver_settles')!
const chainOf = (found: typeof settlement): NoteChain => ({
  issue: decodeIssue(hexToBytes(found.issue)),
  spends: found.spends.map((spend) => decodeSpend(hexToBytes(spend))),
})
const chain = chainOf(settlement)
const signature = new Uint8Array(64).fill(7)

type Calls = {
  simulated: number
  sent: number
  tokenAccountMissing: boolean
  simulationError: object | null
  status: object
}

function context(over: Partial<Calls> = {}) {
  const calls: Calls = {
    simulated: 0,
    sent: 0,
    tokenAccountMissing: false,
    simulationError: null,
    status: { confirmationStatus: 'confirmed', err: null },
    ...over,
  }
  const send = <T>(value: T) => ({ send: async () => value })
  const rpc = {
    getLatestBlockhash: () =>
      send({
        context: { slot: 5n },
        value: { blockhash: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', lastValidBlockHeight: 9n },
      }),
    getAccountInfo: (account: Address) => ({
      send: async () => {
        const token = await associatedTokenAddress(wallet, mint, tokenProgram)
        const exists = account === mint || (account === token && !calls.tokenAccountMissing)
        return { value: exists ? { owner: tokenProgram } : null }
      },
    }),
    simulateTransaction: () => {
      calls.simulated++
      return send({ value: { err: calls.simulationError } })
    },
    getSignatureStatuses: () => send({ value: [calls.status] }),
  }
  const signer = {
    address: wallet,
    signAndSendTransactions: async () => {
      calls.sent++
      return [signature]
    },
  } as unknown as TransactionSendingSigner
  const ctx = {
    rpc,
    getTransactionSigner: vi.fn(() => signer),
    programAddress: getAddressDecoder().decode(program),
    noteDomain: hexToBytes(vectors.domain.note),
    mint,
  } as unknown as SelfSettleContext
  return { ctx, calls }
}

describe('settling a note with the wallet of the person', () => {
  it('has the wallet send the settlement once Solana would accept it, and says which transaction', async () => {
    const { ctx, calls } = context()
    const outcome = await selfSettle(ctx, walletBytes, chain)
    expect(outcome).toEqual({ kind: 'sent', signature: getBase58Decoder().decode(signature) })
    expect(calls).toMatchObject({ simulated: 1, sent: 1 })
  })

  it('sends nothing when Solana would reject it, and names the reason', async () => {
    const { ctx, calls } = context({ simulationError: { InstructionError: [1, { Custom: 6001 }] } })
    expect(await selfSettle(ctx, walletBytes, chain)).toMatchObject({ kind: 'failed', reason: 'rejected' })
    expect(calls.sent).toBe(0)
  })

  it('does not ask the wallet when the account that receives the money does not exist', async () => {
    const { ctx, calls } = context({ tokenAccountMissing: true })
    expect(await selfSettle(ctx, walletBytes, chain)).toEqual({ kind: 'failed', reason: 'no_token_account' })
    expect(calls).toMatchObject({ simulated: 0, sent: 0 })
  })

  it('does not count it settled when the cluster says the transaction failed', async () => {
    const { ctx } = context({ status: { confirmationStatus: 'confirmed', err: { InstructionError: [1, 'Custom'] } } })
    expect(await selfSettle(ctx, walletBytes, chain)).toMatchObject({ kind: 'failed', reason: 'failed' })
  })

  it('says the wallet declined when the person closes it, without a cluster error', async () => {
    const { ctx } = context()
    ctx.getTransactionSigner = () =>
      ({
        address: wallet,
        signAndSendTransactions: async () => {
          throw Object.assign(new Error('declined'), { code: 'ERROR_AUTHORIZATION_FAILED' })
        },
      }) as unknown as TransactionSendingSigner
    expect(await selfSettle(ctx, walletBytes, chain)).toMatchObject({ kind: 'failed', reason: 'declined' })
  })

  it('leaves a note that went through other phones to a longer settlement', async () => {
    const { ctx, calls } = context()
    expect(await selfSettle(ctx, walletBytes, chainOf(through))).toEqual({ kind: 'failed', reason: 'too_long' })
    expect(calls.sent).toBe(0)
  })
})
