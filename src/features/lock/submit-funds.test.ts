import { hexToBytes } from '@noble/hashes/utils.js'
import {
  address,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  type SignatureBytes,
  type Transaction,
  type TransactionSendingSigner,
} from '@solana/kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import operations from '../../../gateway/tests/fixtures/operations.json'
import type { Activation } from '../identity/activation'
import { addFunds } from './submit-funds'
import type { Gateway, Prepared } from './gateway'
import { buildLockTransaction } from './messages'

vi.mock('../../../modules/hardware-keys/src/HardwareKeysModule', () => import('../../keys/test-support/hardware-keys'))

const WALLET = address(operations.wallet)
const FEE_PAYER = address(operations.feePayer)
const PROGRAM = address(operations.programId)
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const MINT = address(operations.mint)
const FUNDER = address(operations.funder)
const key = hexToBytes(operations.device)
const SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(9))
const who = { wallet: WALLET, key, lockSeq: 3 }

const offer = (overrides: Partial<Activation> = {}): Activation => ({
  funding: { mint: MINT, tokenProgram: TOKEN_PROGRAM, account: FUNDER, decimals: 6, balance: 20_000_000n },
  quote: {
    available: true,
    fee: 0n,
    feeMode: 'off',
    minFunding: 5_000_000n,
    pressure: 0,
    maxLockDays: 45,
    reason: null,
  },
  sol: { balance: 0n, cost: 4_000_000n },
  defaultAmount: 5_000_000n,
  defaultLockDays: 30,
  minLockDays: 15,
  maxLockDays: 365,
  ...overrides,
})

let requests: Record<string, unknown>[]
let submitted: number
let sentByWallet: Transaction[]
const reply = <T>(value: T) => ({ send: async () => value })
const gateway: Gateway = {
  quote: async () => {
    throw new Error('not used')
  },
  async prepare(_kind, request) {
    requests.push(request)
    const terms = {
      programAddress: PROGRAM,
      feePayer: FEE_PAYER,
      blockhash: operations.blockhash,
      lastValidBlockHeight: 100n,
      computeUnitLimit: 30_000,
      computeUnitPrice: 5_000n,
    }
    const transaction = await buildLockTransaction(terms, {
      wallet: WALLET,
      key,
      funder: address(request.funder as string),
      mint: MINT,
      tokenProgram: TOKEN_PROGRAM,
      bond: BigInt(request.bond as string),
      backing: BigInt(request.backing as string),
      lockUntil: request.lockUntil as number,
      lockSeq: 3,
    })
    return {
      transaction: getBase64EncodedWireTransaction(transaction),
      feePayer: FEE_PAYER,
      blockhash: operations.blockhash,
      computeUnitLimit: 30_000,
      computeUnitPrice: 5_000,
      sponsorFee: 0n,
    } satisfies Prepared
  },
  async submit() {
    submitted++
    return { signature: SIGNATURE }
  },
  rotationPending: async () => ({ pending: false }),
}
const signer: TransactionSendingSigner = {
  address: WALLET,
  signAndSendTransactions: async (transactions) => {
    sentByWallet.push(transactions[0] as Transaction)
    return [new Uint8Array(64).fill(9) as SignatureBytes]
  },
}
const signTransactions = vi.fn(async (transaction: Transaction) => ({
  ...transaction,
  signatures: { ...transaction.signatures, [WALLET]: new Uint8Array(64).fill(7) as SignatureBytes },
}))
const context = () =>
  ({
    rpc: {
      getLatestBlockhash: () =>
        reply({ context: { slot: 1n }, value: { blockhash: operations.blockhash, lastValidBlockHeight: 100n } }),
      simulateTransaction: () => reply({ context: { slot: 1n }, value: { err: null, logs: [] } }),
      getSignatureStatuses: () =>
        reply({ context: { slot: 1n }, value: [{ err: null, confirmationStatus: 'confirmed' }] }),
    },
    programAddress: PROGRAM,
    gateway,
    getTransactionSigner: () => signer,
    signTransactions,
    mint: MINT,
    windows: { grace: 0, challenge: 0, claimWindow: 0, minNoteLife: 0, releaseDelay: 0, rotationDelay: 0 },
  }) as never

describe('adding funds', () => {
  beforeEach(() => {
    requests = []
    submitted = 0
    sentByWallet = []
    signTransactions.mockClear()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
  })

  it('has the gateway lend the rents and send it, the wallet only signing', async () => {
    const outcome = await addFunds(context(), offer(), 'free', who, { amount: 5_000_000n, lockDays: 30 })
    expect(outcome).toEqual({ status: 'done', signature: SIGNATURE })
    expect(requests).toEqual([
      {
        wallet: WALLET,
        key: operations.device,
        funder: FUNDER,
        bond: '2000000',
        backing: '3000000',
        lockUntil: Math.floor(Date.now() / 1000) + 30 * 86_400,
      },
    ])
    expect(signTransactions).toHaveBeenCalledTimes(1)
    expect(submitted).toBe(1)
    expect(sentByWallet).toHaveLength(0)
  })

  it('refuses funds the wallet does not hold before the wallet is asked', async () => {
    const outcome = await addFunds(context(), offer(), 'free', who, { amount: 30_000_000n, lockDays: 30 })
    expect(outcome).toEqual({
      status: 'failed',
      error:
        'Your wallet has 20 USDC and this needs 30 USDC. Add USDC to your wallet, then try again. Nothing was sent.',
      payInstead: false,
    })
    expect(requests).toHaveLength(0)
    expect(signTransactions).not.toHaveBeenCalled()
  })

  it('refuses to pay the network from a wallet that cannot, before it is asked', async () => {
    const outcome = await addFunds(context(), offer({ quote: undefined }), undefined, who, {
      amount: 5_000_000n,
      lockDays: 30,
    })
    expect(outcome).toMatchObject({
      status: 'failed',
      error:
        'Your wallet has 0 SOL and this costs about 0.004 SOL in network costs. Add SOL to your wallet, then try again. Nothing was sent.',
    })
    expect(sentByWallet).toHaveLength(0)
  })

  it('has the wallet pay when it holds the SOL and the gateway does not offer', async () => {
    const outcome = await addFunds(
      context(),
      offer({ quote: undefined, sol: { balance: 9_000_000n, cost: 4_000_000n } }),
      undefined,
      who,
      { amount: 5_000_000n, lockDays: 30 },
    )
    expect(outcome).toEqual({ status: 'done', signature: SIGNATURE })
    expect(sentByWallet).toHaveLength(1)
    expect(submitted).toBe(0)
  })
})
