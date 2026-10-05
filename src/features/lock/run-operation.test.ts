import { hexToBytes } from '@noble/hashes/utils.js'
import {
  SolanaMobileWalletAdapterProtocolError,
  SolanaMobileWalletAdapterProtocolErrorCode,
} from '@solana-mobile/mobile-wallet-adapter-protocol'
import {
  address,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  type SignatureBytes,
  type Transaction,
  type TransactionSendingSigner,
} from '@solana/kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import operations from '../../../gateway/tests/fixtures/operations.json'
import { GatewayError, type Gateway, type Prepared } from './gateway'
import { buildWithdrawalTransaction, type SponsorTerms } from './messages'
import { withdrawalOperation } from './operations'
import { describeOperationError, runOperation } from './run-operation'
import type { PerformContext } from './perform'

const WALLET = address(operations.wallet)
const FEE_PAYER = address(operations.feePayer)
const PROGRAM = address(operations.programId)
const params = {
  programAddress: PROGRAM,
  wallet: WALLET,
  key: hexToBytes(operations.device),
  rentReceiver: address(operations.rentReceiver),
  lockSeq: operations.lockSeq,
  mint: address(operations.mint),
  tokenProgram: address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  destination: address(operations.destination),
}
const terms: SponsorTerms = {
  programAddress: PROGRAM,
  feePayer: FEE_PAYER,
  blockhash: operations.blockhash,
  lastValidBlockHeight: 100n,
  computeUnitLimit: 30_000,
  computeUnitPrice: 5_000n,
}
const SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(9))

let status: { err: unknown; confirmationStatus: string } | null
let simulation: unknown
let gateway: Gateway & { submitted: number }
let walletAnswer: 'signs' | 'declines' | 'unsupported'
let sentByWallet: Transaction[]

const reply = <T>(value: T) => ({ send: async () => value })
const rpc = {
  getLatestBlockhash: () =>
    reply({
      context: { slot: 1n },
      value: { blockhash: operations.blockhash, lastValidBlockHeight: 100n },
    }),
  simulateTransaction: () => reply({ context: { slot: 1n }, value: { err: simulation, logs: [] } }),
  getSignatureStatuses: () => reply({ context: { slot: 1n }, value: [status] }),
}
const signer: TransactionSendingSigner = {
  address: WALLET,
  signAndSendTransactions: async (transactions) => {
    sentByWallet.push(transactions[0] as Transaction)
    return [new Uint8Array(64).fill(9) as SignatureBytes]
  },
}
const context = (withGateway = true): PerformContext & { rpc: never } =>
  ({
    rpc,
    programAddress: PROGRAM,
    gateway: withGateway ? gateway : undefined,
    getTransactionSigner: () => signer,
    signTransactions: async (transaction: Transaction) => {
      if (walletAnswer === 'declines') {
        throw new SolanaMobileWalletAdapterProtocolError(
          0,
          SolanaMobileWalletAdapterProtocolErrorCode.ERROR_NOT_SIGNED,
          'User declined',
        )
      }
      if (walletAnswer === 'unsupported')
        throw new SolanaMobileWalletAdapterProtocolError(0, -32601, 'Method not found')
      return { ...transaction, signatures: { ...transaction.signatures, [WALLET]: new Uint8Array(64).fill(7) } }
    },
  }) as never

describe('running an operation', () => {
  beforeEach(() => {
    status = { err: null, confirmationStatus: 'confirmed' }
    simulation = null
    walletAnswer = 'signs'
    sentByWallet = []
    const prepare = async (): Promise<Prepared> => ({
      transaction: getBase64EncodedWireTransaction(await buildWithdrawalTransaction(terms, params)),
      feePayer: FEE_PAYER,
      blockhash: operations.blockhash,
      computeUnitLimit: terms.computeUnitLimit,
      computeUnitPrice: Number(terms.computeUnitPrice),
      sponsorFee: 0n,
    })
    gateway = {
      submitted: 0,
      quote: async () => {
        throw new Error('not used')
      },
      prepare,
      async submit() {
        this.submitted++
        return { signature: SIGNATURE }
      },
      rotationPending: async () => ({ pending: false }),
    }
  })

  afterEach(() => vi.useRealTimers())

  it('has the gateway pay and send it once the wallet signed it', async () => {
    expect(await runOperation(context(), withdrawalOperation(params), true)).toEqual({
      status: 'done',
      signature: SIGNATURE,
    })
    expect(gateway.submitted).toBe(1)
    expect(sentByWallet).toHaveLength(0)
  })

  it('has the wallet pay and send it when it is not sponsored', async () => {
    expect(await runOperation(context(false), withdrawalOperation(params), false)).toEqual({
      status: 'done',
      signature: SIGNATURE,
    })
    expect(sentByWallet).toHaveLength(1)
    expect(gateway.submitted).toBe(0)
  })

  it('offers the wallet paying when the gateway refuses, and sent nothing', async () => {
    gateway.prepare = async () => {
      throw new GatewayError(503, 'sponsorship is unavailable')
    }
    expect(await runOperation(context(), withdrawalOperation(params), true)).toMatchObject({
      status: 'failed',
      error: 'Buckspay couldn’t pay for this. Nothing was sent and nothing was charged.',
      payInstead: true,
    })
    expect(gateway.submitted).toBe(0)
  })

  it('offers the wallet paying when the gateway refuses to send what the wallet signed', async () => {
    gateway.submit = async () => {
      throw new GatewayError(410, 'no prepared transaction for this key')
    }
    expect(await runOperation(context(), withdrawalOperation(params), true)).toMatchObject({
      status: 'failed',
      payInstead: true,
    })
  })

  it('offers the wallet paying when the wallet cannot sign without sending', async () => {
    walletAnswer = 'unsupported'
    expect(await runOperation(context(), withdrawalOperation(params), true)).toMatchObject({
      status: 'failed',
      error: 'Your wallet can’t sign a transaction that Buckspay pays for. Nothing was sent and nothing was charged.',
      payInstead: true,
    })
  })

  it('reports a declined signature without offering anything else', async () => {
    walletAnswer = 'declines'
    expect(await runOperation(context(), withdrawalOperation(params), true)).toEqual({
      status: 'failed',
      error: 'You declined in your wallet. Nothing was sent and nothing was charged.',
      details: 'User declined',
      payInstead: false,
    })
  })

  it('refuses what Solana would reject before the wallet is asked', async () => {
    simulation = { InstructionError: [0, { Custom: 6001 }] }
    expect(await runOperation(context(false), withdrawalOperation(params), false)).toEqual({
      status: 'failed',
      error: 'Solana would reject this. Nothing was sent and nothing was charged.',
      details: '{"InstructionError":[0,{"Custom":6001}]}',
      payInstead: false,
    })
    expect(sentByWallet).toHaveLength(0)
  })

  it('reports a transaction the cluster confirmed as failed, and one it never confirmed', async () => {
    status = { err: { InstructionError: [0, { Custom: 6001 }] }, confirmationStatus: 'confirmed' }
    expect(await runOperation(context(false), withdrawalOperation(params), false)).toMatchObject({
      status: 'failed',
      error: 'Solana rejected the transaction. No funds moved.',
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    status = null
    let outcome: Awaited<ReturnType<typeof runOperation>> | undefined
    void runOperation(context(false), withdrawalOperation(params), false).then((value) => (outcome = value))
    while (!outcome) {
      if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync()
      else await new Promise((resolve) => setImmediate(resolve))
    }
    expect(outcome).toMatchObject({
      status: 'failed',
      error: 'Solana hasn’t confirmed the transaction yet. It may still land; check your locks in a minute.',
    })
  })

  it('says it cannot reach the network without claiming that nothing was sent', () => {
    expect(describeOperationError(new TypeError('Network request failed')).error).toContain(
      'The transaction may not have been sent',
    )
  })
})
