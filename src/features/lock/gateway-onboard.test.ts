import { hexToBytes } from '@noble/hashes/utils.js'
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  decompileTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  type Instruction,
  type SignatureBytes,
  type Transaction,
} from '@solana/kit'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import onboard from '../../../gateway/tests/fixtures/onboard.json'
import {
  MAX_SPONSORED_PRIORITY_FEE,
  type OperationContext,
  prepareSponsored,
  signSponsored,
  SponsorshipError,
  submitSponsored,
} from './gateway-onboard'
import type { Gateway, Prepared } from './gateway'
import { buildOnboardTransaction, type SponsorTerms } from './messages'
import { onboardOperation } from './operations'

const WALLET = address(onboard.wallet)
const FEE_PAYER = address(onboard.feePayer)
const PROGRAM = address(onboard.programId)
const OTHER = address('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')
const key = hexToBytes(onboard.device)
const binding = { key, signature: hexToBytes(onboard.signature), envelope: hexToBytes(onboard.envelope) }
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

const operation = (sponsorFee = 0n) =>
  onboardOperation({
    programAddress: PROGRAM,
    wallet: WALLET,
    binding,
    funder: address(onboard.funder),
    mint: address(onboard.mint),
    tokenProgram: TOKEN_PROGRAM,
    bond: BigInt(onboard.bond),
    backing: BigInt(onboard.backing),
    lockUntil: onboard.lockUntil,
    sponsorFee,
  })

const terms = (): SponsorTerms => ({
  programAddress: PROGRAM,
  feePayer: FEE_PAYER,
  blockhash: onboard.blockhash,
  lastValidBlockHeight: 0n,
  computeUnitLimit: onboard.computeUnitLimit,
  computeUnitPrice: BigInt(onboard.computeUnitPrice),
})

/** What a gateway offers: `transaction` with its description, which the app must not take on trust. */
function offer(transaction: Transaction, overrides: Partial<Prepared> = {}): Prepared {
  return {
    transaction: getBase64EncodedWireTransaction(transaction),
    feePayer: FEE_PAYER,
    blockhash: onboard.blockhash,
    computeUnitLimit: onboard.computeUnitLimit,
    computeUnitPrice: onboard.computeUnitPrice,
    sponsorFee: 0n,
    ...overrides,
  }
}

const rpc = {
  getLatestBlockhash: () => ({
    send: async () => ({ context: { slot: 1n }, value: { blockhash: onboard.blockhash, lastValidBlockHeight: 100n } }),
  }),
} as unknown as OperationContext['rpc']

let prepared: Prepared
let gateway: Gateway
let signTransactions: Mock<OperationContext['signTransactions']>
const context = (): OperationContext => ({
  rpc,
  signTransactions,
  gateway,
  programAddress: PROGRAM,
})

/** The transaction with `instruction` appended. */
function with_(transaction: Transaction, instruction: Instruction): Transaction {
  const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(transaction.messageBytes))
  return compileTransaction(appendTransactionMessageInstruction(instruction, message))
}

describe('sponsored operations', () => {
  beforeEach(() => {
    signTransactions = vi.fn(async (transaction: Transaction) => ({
      ...transaction,
      signatures: { ...transaction.signatures, [WALLET]: new Uint8Array(64).fill(7) as SignatureBytes },
    }))
    gateway = {
      quote: vi.fn(),
      prepare: vi.fn(async () => prepared),
      submit: vi.fn(async () => ({ signature: 'signature' })),
      rotationPending: vi.fn(),
    }
  })

  it('accepts the gateway’s transaction only when it is byte for byte the app’s own', async () => {
    const own = await buildOnboardTransaction(terms(), {
      wallet: WALLET,
      key,
      binding,
      funder: address(onboard.funder),
      mint: address(onboard.mint),
      tokenProgram: TOKEN_PROGRAM,
      bond: BigInt(onboard.bond),
      backing: BigInt(onboard.backing),
      lockUntil: onboard.lockUntil,
    })
    prepared = offer(own)
    const accepted = await prepareSponsored(context(), operation())
    expect(accepted.transaction.messageBytes).toEqual(own.messageBytes)
    expect(accepted.lastValidBlockHeight).toBe(250n)
    expect(gateway.prepare).toHaveBeenCalledWith('onboard', expect.objectContaining({ wallet: WALLET }))
  })

  it('refuses a changed amount, fee, recipient, payer, extra instruction, signer or second registration before the wallet sees it', async () => {
    const base = {
      wallet: WALLET,
      key,
      binding,
      funder: address(onboard.funder),
      mint: address(onboard.mint),
      tokenProgram: TOKEN_PROGRAM,
      bond: BigInt(onboard.bond),
      backing: BigInt(onboard.backing),
      lockUntil: onboard.lockUntil,
    }
    const own = await buildOnboardTransaction(terms(), base)
    const theft = {
      programAddress: address('11111111111111111111111111111111'),
      accounts: [
        { address: WALLET, role: AccountRole.WRITABLE_SIGNER },
        { address: OTHER, role: AccountRole.WRITABLE },
      ],
      data: new Uint8Array([2, 0, 0, 0, 0, 148, 53, 119, 0, 0, 0, 0]),
    }
    const register = decompileTransactionMessage(
      getCompiledTransactionMessageDecoder().decode(own.messageBytes),
    ).instructions.at(-2)!
    const cases: Record<string, Prepared> = {
      'a changed amount': offer(await buildOnboardTransaction(terms(), { ...base, backing: base.backing + 1n })),
      'a changed funder': offer(await buildOnboardTransaction(terms(), { ...base, funder: OTHER })),
      'a fee it did not quote': offer(
        await buildOnboardTransaction(terms(), { ...base, sponsorFee: 150_000n, sponsorToken: OTHER }),
        { sponsorFee: 150_000n },
      ),
      'a fee described as none': offer(
        await buildOnboardTransaction(terms(), { ...base, sponsorFee: 1n, sponsorToken: OTHER }),
      ),
      'another payer': offer(await buildOnboardTransaction({ ...terms(), feePayer: OTHER }, base)),
      'an extra instruction': offer(with_(own, theft)),
      'a second registration': offer(with_(own, register)),
      'a price above the cap': offer(
        await buildOnboardTransaction({ ...terms(), computeUnitPrice: MAX_SPONSORED_PRIORITY_FEE + 1n }, base),
        { computeUnitPrice: Number(MAX_SPONSORED_PRIORITY_FEE) + 1 },
      ),
      'a limit above the ceiling': offer(
        await buildOnboardTransaction({ ...terms(), computeUnitLimit: 100_001 }, base),
        { computeUnitLimit: 100_001 },
      ),
      'a fee payer that is not an address': offer(own, { feePayer: 'not-an-address' }),
      'the wallet as payer': offer(await buildOnboardTransaction({ ...terms(), feePayer: WALLET }, base), {
        feePayer: WALLET,
      }),
    }
    for (const [name, answer] of Object.entries(cases)) {
      prepared = answer
      await expect(prepareSponsored(context(), operation()), name).rejects.toMatchObject({ reason: 'mismatch' })
    }
    expect(signTransactions).not.toHaveBeenCalled()
  })

  it('refuses a fee it was not quoted, and takes the quoted one to the sponsor’s associated token account', async () => {
    const fee = 150_000n
    const own = await prepareSponsored(
      { ...context(), gateway: { ...gateway, prepare: async (_kind, _request) => prepared } },
      operation(fee),
    ).catch((error: unknown) => error)
    // The gateway has not offered the fee yet.
    expect(own).toBeInstanceOf(SponsorshipError)
    const withFee = await buildOnboardTransaction(terms(), {
      wallet: WALLET,
      key,
      binding,
      funder: address(onboard.funder),
      mint: address(onboard.mint),
      tokenProgram: TOKEN_PROGRAM,
      bond: BigInt(onboard.bond),
      backing: BigInt(onboard.backing),
      lockUntil: onboard.lockUntil,
      sponsorFee: fee,
      sponsorToken: (await operation(fee).sponsorToken(FEE_PAYER))!,
    })
    prepared = offer(withFee, { sponsorFee: fee })
    expect((await prepareSponsored(context(), operation(fee))).transaction.messageBytes).toEqual(withFee.messageBytes)
    // The same transaction for a user who was quoted no fee.
    await expect(prepareSponsored(context(), operation(0n))).rejects.toMatchObject({ reason: 'mismatch' })
  })

  it('has the wallet approve once, and sends only what the wallet signed', async () => {
    const own = await buildOnboardTransaction(terms(), {
      wallet: WALLET,
      key,
      binding,
      funder: address(onboard.funder),
      mint: address(onboard.mint),
      tokenProgram: TOKEN_PROGRAM,
      bond: BigInt(onboard.bond),
      backing: BigInt(onboard.backing),
      lockUntil: onboard.lockUntil,
    })
    prepared = offer(own)
    const sponsored = await prepareSponsored(context(), operation())
    const signed = await signSponsored(context(), WALLET, sponsored)
    expect(signTransactions).toHaveBeenCalledTimes(1)
    expect(await submitSponsored(context(), operation(), signed)).toBe('signature')
    expect(gateway.submit).toHaveBeenCalledWith('onboard', {
      key: onboard.device,
      transaction: getBase64EncodedWireTransaction(signed),
    })
  })

  it('refuses a transaction the wallet changed, or signed without the signatures the message requires', async () => {
    const own = await buildOnboardTransaction(terms(), {
      wallet: WALLET,
      key,
      binding,
      funder: address(onboard.funder),
      mint: address(onboard.mint),
      tokenProgram: TOKEN_PROGRAM,
      bond: BigInt(onboard.bond),
      backing: BigInt(onboard.backing),
      lockUntil: onboard.lockUntil,
    })
    prepared = offer(own)
    const sponsored = await prepareSponsored(context(), operation())
    signTransactions.mockImplementationOnce(async (transaction: Transaction) => {
      const messageBytes = Uint8Array.from(transaction.messageBytes)
      messageBytes[messageBytes.length - 1] ^= 1
      return {
        messageBytes: messageBytes as unknown as Transaction['messageBytes'],
        signatures: { [WALLET]: new Uint8Array(64).fill(7) as SignatureBytes },
      }
    })
    await expect(signSponsored(context(), WALLET, sponsored)).rejects.toMatchObject({ reason: 'altered' })
    signTransactions.mockImplementationOnce(async (transaction: Transaction) => ({ ...transaction, signatures: {} }))
    await expect(signSponsored(context(), WALLET, sponsored)).rejects.toMatchObject({ reason: 'altered' })
    expect(gateway.submit).not.toHaveBeenCalled()
  })

  it('treats a gateway that refuses to prepare as unavailable', async () => {
    gateway.prepare = vi.fn(async () => Promise.reject(new Error('down')))
    await expect(prepareSponsored(context(), operation())).rejects.toMatchObject({ reason: 'unavailable' })
    await expect(prepareSponsored({ ...context(), gateway: undefined }, operation())).rejects.toMatchObject({
      reason: 'unavailable',
    })
  })
})
