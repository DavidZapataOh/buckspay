import { p256 } from '@noble/curves/nist.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  BUCKSPAY_PROGRAM_ADDRESS,
  findDevicePda,
  findLockPda,
  getCreateLockInstructionDataDecoder,
  getDeviceEncoder,
  getDeviceSize,
  getLedgerSize,
  getLockEncoder,
  getLockSize,
  getRegisterDeviceInstructionDataDecoder,
  registerDeviceComputeUnitLimit,
} from '@project/anchor'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  getSetComputeUnitLimitInstructionDataDecoder,
  getSetComputeUnitPriceInstruction,
} from '@solana-program/compute-budget'
import {
  SolanaMobileWalletAdapterError,
  SolanaMobileWalletAdapterErrorCode,
  SolanaMobileWalletAdapterProtocolError,
  SolanaMobileWalletAdapterProtocolErrorCode,
} from '@solana-mobile/mobile-wallet-adapter-protocol'
import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  decompileTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type SignatureBytes,
  type Transaction,
  type TransactionSendingSigner,
} from '@solana/kit'
import type { WalletAuthorization } from '@wallet-ui/react-native-kit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureDeviceKey, getDeviceKey } from '../../keys'
import HardwareKeys, { resetHardwareKeys } from '../../keys/test-support/hardware-keys'
import { deviceBindingEnvelope, DEVNET_GENESIS_HASH, domain, Purpose, resolveProfile } from '../../protocol'
import { SECP256R1_PROGRAM_ADDRESS } from '../../solana/secp256r1'
import { resetAsyncStorage, storedItems } from '../../test-support/async-storage'
import { createAuthorizationCache } from '../wallet/authorization-cache'
import {
  advanceIdentity,
  describeIdentityError,
  type IdentityContext,
  type IdentityState,
  resolveIdentity,
} from './device-identity'
import { formatSol } from '../../utils/format-sol'
import { onboardingCopy } from '../lock/lock-copy'
import { GatewayError, type Prepared, type Quote } from '../lock/gateway'
import { MAX_SPONSORED_PRIORITY_FEE } from '../lock/gateway-onboard'
import { buildOnboardTransaction } from '../lock/messages'
import { associatedTokenAddress } from '../lock/operations'

vi.mock('../../../modules/hardware-keys/src/HardwareKeysModule', () => import('../../keys/test-support/hardware-keys'))
vi.mock('@react-native-async-storage/async-storage', () => import('../../test-support/async-storage'))

const ALICE = address('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS')
const BOB = address('EUhWSZAfU8hDki7AXskYrwh8ErwXN8iqicaHTP7yQfYS')
const CHAIN = 'solana:localnet'
const cache = createAuthorizationCache(CHAIN)
const DEVICE_DOMAIN = domain(
  Purpose.Device,
  DEVNET_GENESIS_HASH,
  Uint8Array.from(getAddressEncoder().encode(BUCKSPAY_PROGRAM_ADDRESS)),
)
const MINT = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const WINDOWS = resolveProfile({}).windows
/** 6,960 lamports per byte, as the cluster double rents it. */
const rent = (size: number) => BigInt(size + 128) * 6_960n
/**
 * The rents of the device, lock and ledger accounts and the escrow token account, and the fee of one
 * transaction signature and one secp256r1 signature.
 */
const COST = rent(getDeviceSize()) + rent(getLockSize()) + rent(getLedgerSize()) + rent(165) + 10_000n
const EXPIRED = 'The activation expired before it landed. Nothing was charged and this phone is not activated.'
const UNREACHABLE = 'Can’t reach Solana. Check your connection and try again. Nothing was sent.'
const UNCONFIRMED = 'Can’t reach Solana to check the activation. It may still land; check again once you’re online.'
const STALLED = 'Solana hasn’t confirmed the activation yet. It may still land; check again in a minute.'
const reply = <T>(value: T) => ({ send: async () => value })
// What `fetch` throws in React Native without a connection.
const failure = (error: Error = new TypeError('Network request failed')) => ({
  send: async () => Promise.reject(error),
})
const authorization = (wallet: Address): WalletAuthorization => {
  const account = { address: wallet, addressBase64: '', label: wallet }
  return { accounts: [account], authToken: `token-${wallet}`, selectedAccount: account }
}

/**
 * A cluster that runs the activation the way the program does: it checks the secp256r1 verification
 * against the binding it rebuilds, then creates the device and lock accounts at `confirmed` and
 * moves the funds. Its slots are its block heights.
 */
class Cluster {
  accounts = new Map<Address, Uint8Array>()
  balances = new Map<Address, bigint>()
  /** The funding token balance of each wallet's associated token account; every wallet holds 100 USDC. */
  tokens = new Map<Address, bigint>()
  statuses = new Map<string, { err: unknown; confirmationStatus: 'confirmed' }>()
  blockHeight = 100n
  /**
   * `later`: the transaction lands once the app has read the device account twice more; `fails`: it
   * fails on-chain.
   */
  landing: 'now' | 'later' | 'never' | 'fails' = 'now'
  /** How many more device account reads a `later` landing waits for. */
  laterReads = 2
  /** Every request fails, as without a connection. */
  offline = false
  accountsUnavailable = false
  /** The block height stops moving. */
  stalled = false
  /**
   * The next `lagging` account reads reach a node still at slot 1: it answers a read that asks for
   * no later slot with what it saw then, and refuses one that does.
   */
  lagging = 0
  /** The error a simulated activation fails with. */
  simulationError: unknown = null
  simulated = 0
  private landings: { reads: number; create: () => void }[] = []
  sent: Transaction[] = []
  /** One per sent transaction, settled once the cluster has processed it. */
  processed: Promise<SignatureBytes>[] = []

  private readonly methods = {
    getAccountInfo: (account: Address, config?: { minContextSlot?: bigint }) => {
      if (this.accountsUnavailable) return failure()
      for (const landing of this.landings) if (--landing.reads === 0) landing.create()
      if (this.lagging > 0) {
        this.lagging--
        if ((config?.minContextSlot ?? 0n) > 1n) return failure(new Error('Minimum context slot has not been reached'))
        return reply({ context: { slot: 1n }, value: null })
      }
      const data = this.accounts.get(account)
      return reply({
        context: { slot: this.blockHeight },
        value: data
          ? {
              data: [getBase64Decoder().decode(data), 'base64'],
              executable: false,
              lamports: 1_176_240n,
              owner: BUCKSPAY_PROGRAM_ADDRESS,
              space: BigInt(data.length),
            }
          : null,
      })
    },
    getBalance: (account: Address) =>
      reply({ context: { slot: this.blockHeight }, value: this.balances.get(account) ?? 2_000_000_000n }),
    // Each read finds 20 more blocks, unless the cluster stalled: a blockhash is valid for 50 of them.
    getEpochInfo: () => {
      const blockHeight = this.blockHeight
      if (!this.stalled) this.blockHeight += 20n
      return reply({ absoluteSlot: blockHeight, blockHeight })
    },
    // 5,000 lamports per signature: the wallet's and the secp256r1 verification's.
    getFeeForMessage: (message: string) => {
      const { header } = getCompiledTransactionMessageDecoder().decode(getBase64Encoder().encode(message))
      return reply({ context: { slot: this.blockHeight }, value: 5_000n * BigInt(header.numSignerAccounts + 1) })
    },
    getLatestBlockhash: () =>
      reply({
        context: { slot: 1n },
        value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: this.blockHeight + 50n },
      }),
    getMinimumBalanceForRentExemption: (size: bigint) => reply((size + 128n) * 6_960n),
    // The funding mint (6 decimals, owned by the token program) and the wallets' token accounts.
    getMultipleAccounts: (addresses: Address[]) => ({
      send: async () => {
        const value = await Promise.all(
          addresses.map(async (account) => {
            const data = new Uint8Array(account === MINT ? 82 : 165)
            if (account === MINT) data[44] = 6
            else {
              const owner = await this.tokenOwner(account)
              if (!owner) return null
              new DataView(data.buffer).setBigUint64(64, this.tokens.get(account) ?? 100_000_000n, true)
            }
            return {
              data: [getBase64Decoder().decode(data), 'base64'] as const,
              executable: false,
              lamports: 1n,
              owner: TOKEN_PROGRAM,
              space: BigInt(data.length),
            }
          }),
        )
        return { context: { slot: this.blockHeight }, value }
      },
    }),
    getSignatureStatuses: (signatures: string[]) =>
      reply({ context: { slot: this.blockHeight }, value: signatures.map((s) => this.statuses.get(s) ?? null) }),
    simulateTransaction: (
      wire: string,
      config: { encoding: string; sigVerify: boolean; replaceRecentBlockhash: boolean },
    ) => {
      expect(config).toMatchObject({ encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true })
      this.simulated++
      const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire))
      return {
        send: async () => {
          const { device } = await this.check(transaction)
          const err = this.accounts.has(device) ? { InstructionError: [2, { Custom: 0 }] } : this.simulationError
          return { context: { slot: this.blockHeight }, value: { err, logs: [], unitsConsumed: 10_000n } }
        },
      }
    },
  }

  rpc = new Proxy(this.methods, {
    get: (methods, name: keyof Cluster['methods']) =>
      this.offline ? () => failure() : (methods[name] as (...args: unknown[]) => unknown),
  }) as unknown as IdentityContext['rpc']

  /** The wallets whose token accounts exist: every address the tests use. */
  private readonly wallets = [ALICE, BOB]

  private async tokenOwner(account: Address) {
    for (const wallet of this.wallets) {
      if (account === (await associatedTokenAddress(wallet, MINT, TOKEN_PROGRAM))) return wallet
    }
    return undefined
  }

  /** Sets a wallet's funding token balance. */
  async fund(wallet: Address, amount: bigint) {
    this.tokens.set(await associatedTokenAddress(wallet, MINT, TOKEN_PROGRAM), amount)
  }

  land(transaction: Transaction): Promise<SignatureBytes> {
    this.sent.push(transaction)
    const processed = this.process(transaction)
    this.processed.push(processed)
    return processed
  }

  /** The checks `register_device` and `create_lock` make, and the accounts they would create. */
  private async check(transaction: Transaction) {
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes)
    if (message.version !== 0) throw new Error(`unexpected transaction version ${message.version}`)
    // A sponsored activation also sets a compute unit price, and its wallet is the second signer.
    const sponsored = message.instructions.length === 5
    const [budget, verify, register, create] = sponsored
      ? [message.instructions[0], ...message.instructions.slice(2)]
      : message.instructions
    expect(message.staticAccounts[budget.programAddressIndex]).toBe(COMPUTE_BUDGET_PROGRAM_ADDRESS)
    expect(message.staticAccounts[verify.programAddressIndex]).toBe(SECP256R1_PROGRAM_ADDRESS)
    expect(message.staticAccounts[register.programAddressIndex]).toBe(BUCKSPAY_PROGRAM_ADDRESS)
    expect(message.staticAccounts[create.programAddressIndex]).toBe(BUCKSPAY_PROGRAM_ADDRESS)
    const wallet = message.staticAccounts[sponsored ? 1 : 0]
    const { key } = getRegisterDeviceInstructionDataDecoder().decode(register.data!)
    const [device] = await findDevicePda(key)
    const { units } = getSetComputeUnitLimitInstructionDataDecoder().decode(budget.data!)
    expect(units).toBeLessThanOrEqual(100_000)
    const data = verify.data!
    expect(data.slice(16, 49)).toEqual(key)
    expect(data.slice(113)).toEqual(
      deviceBindingEnvelope(DEVICE_DOMAIN, getAddressEncoder().encode(wallet) as Uint8Array, Uint8Array.from(key)),
    )
    expect(p256.verify(data.slice(49, 113), data.slice(113), data.slice(16, 49), { prehash: true, lowS: true })).toBe(
      true,
    )
    const lock = getCreateLockInstructionDataDecoder().decode(create.data!)
    expect(lock.lockSeq).toBe(0)
    return { device, wallet, key, lock }
  }

  private async process(transaction: Transaction): Promise<SignatureBytes> {
    const { device, wallet, key, lock } = await this.check(transaction)
    const [lockAddress] = await findLockPda(key, 0)
    const create = () => {
      if (this.accounts.has(device)) throw new Error('already in use')
      this.accounts.set(
        device,
        Uint8Array.from(getDeviceEncoder().encode({ wallet, bump: 255, nextLockSeq: 1, rotations: 0 })),
      )
      this.accounts.set(
        lockAddress,
        Uint8Array.from(
          getLockEncoder().encode({
            mint: MINT,
            bond: lock.bond,
            backing: lock.backing,
            lockUntil: lock.lockUntil,
            bump: 255,
          }),
        ),
      )
    }
    const signature = crypto.getRandomValues(new Uint8Array(64)) as SignatureBytes
    if (this.landing === 'now') create()
    if (this.landing === 'later') this.landings.push({ reads: this.laterReads, create })
    if (this.landing === 'fails') {
      this.statuses.set(getBase58Decoder().decode(signature), {
        err: { InstructionError: [2, { Custom: 6001 }] },
        confirmationStatus: 'confirmed',
      })
    }
    return signature
  }

  async bind(key: Uint8Array, wallet: Address) {
    const [device] = await findDevicePda(key)
    this.accounts.set(
      device,
      Uint8Array.from(getDeviceEncoder().encode({ wallet, bump: 255, nextLockSeq: 1, rotations: 0 })),
    )
  }
}

function instructionsOf(transaction: Transaction) {
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes)
  if (message.version !== 0) throw new Error(`unexpected transaction version ${message.version}`)
  return message.instructions
}

let cluster: Cluster
let wallet: Address
let walletFailure:
  | 'none'
  | 'revoked'
  | 'declined'
  | 'before-sending'
  | 'after-sending'
  | 'killed'
  | 'unsupported'
  | 'altered'
  | 'appends'
  | 'budget'
  | 'reorders'
  | 'one-signature'
let gateway: IdentityContext['gateway']
let walletCalls: number
const connect = vi.fn(async () => cache.set(authorization(wallet)))
const disconnect = vi.fn(async () => cache.clear())
const progress = vi.fn()
const signer = (from: Address): TransactionSendingSigner => ({
  address: from,
  signAndSendTransactions: async (transactions) => {
    walletCalls++
    // Set when the wallet receives the transaction: a test may move on while it lands.
    const failure = walletFailure
    if (failure === 'revoked')
      throw new SolanaMobileWalletAdapterProtocolError(0, -1, 'auth_token not valid for signing')
    if (failure === 'declined')
      throw new SolanaMobileWalletAdapterProtocolError(
        0,
        SolanaMobileWalletAdapterProtocolErrorCode.ERROR_NOT_SIGNED,
        'User declined',
      )
    if (failure === 'before-sending') throw new Error('The wallet closed the session.')
    const signature = await cluster.land(transactions[0] as Transaction)
    if (failure === 'after-sending') throw new Error('The wallet closed the session.')
    // The app is killed while the wallet holds the transaction: the call never returns.
    if (failure === 'killed') return new Promise(() => {})
    return [signature]
  },
})

/** The wallet signing without sending, as for a sponsored registration. */
async function signTransactions(transaction: Transaction): Promise<Transaction> {
  walletCalls++
  const failure = walletFailure
  if (failure === 'revoked') throw new SolanaMobileWalletAdapterProtocolError(0, -1, 'auth_token not valid for signing')
  if (failure === 'declined')
    throw new SolanaMobileWalletAdapterProtocolError(
      0,
      SolanaMobileWalletAdapterProtocolErrorCode.ERROR_NOT_SIGNED,
      'User declined',
    )
  // A wallet without `sign_transactions` answers JSON-RPC's method not found.
  if (failure === 'unsupported') throw new SolanaMobileWalletAdapterProtocolError(0, -32601, 'Method not found')
  if (failure === 'killed') return new Promise(() => {})
  if (failure === 'one-signature') {
    // A wallet that answers with its signature alone, where the message requires two (the Mock MWA
    // Wallet): the wallet kit decodes that answer and throws.
    return getTransactionDecoder().decode(
      Uint8Array.from([1, ...new Uint8Array(64).fill(7), ...transaction.messageBytes]),
    )
  }
  const signatures = { ...transaction.signatures, [wallet]: new Uint8Array(64).fill(7) as SignatureBytes }
  if (failure === 'appends' || failure === 'budget' || failure === 'reorders') {
    // A wallet that rewrites the message it was asked to sign, as some do to add guard instructions.
    const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(transaction.messageBytes))
    const [budget, price, ...rest] = message.instructions
    const rewritten =
      failure === 'appends'
        ? [budget, price, ...rest, { programAddress: MEMO_PROGRAM, data: new Uint8Array([1]) }]
        : failure === 'budget'
          ? [budget, getSetComputeUnitPriceInstruction({ microLamports: 1n }), ...rest]
          : [price, budget, ...rest]
    return { ...compileTransaction({ ...message, instructions: rewritten }), signatures }
  }
  if (failure === 'altered') {
    // A wallet that adds its own priority fee signs another message.
    const messageBytes = Uint8Array.from(transaction.messageBytes)
    messageBytes[messageBytes.length - 1] ^= 1
    return { ...transaction, messageBytes: messageBytes as unknown as Transaction['messageBytes'], signatures }
  }
  return { ...transaction, signatures }
}

const MEMO_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const SPONSOR = address('2t2uAzmxvzM5caJZUeUd4Qg4Qcu39x978yoUzyher8fQ')
const THIEF = address('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')

/**
 * A gateway that pays for activations as the Rust one does, or, as a compromised or broken one
 * could, offers another: one binding its own device key to the wallet, one with a transfer out of
 * the wallet appended, one above the price cap, one with a fee it never quoted, or one it describes
 * with an unparsable fee payer. It refuses to send (`refuses`, `rejects`), sends and then a proxy in
 * front of it fails (`lost`), or never answers the submission (`silent`). A real gateway cannot be
 * made to misbehave, so these cases run against this double; everything Solana does runs on the
 * validator in the gateway's own tests.
 */
class Gateway {
  mode:
    | 'honest'
    | 'unavailable'
    | 'refuses'
    | 'rejects'
    | 'lost'
    | 'silent'
    | 'own-key'
    | 'transfer'
    | 'price'
    | 'unquoted-fee'
    | 'unparsable' = 'honest'
  /** What it quotes now. */
  terms: Quote = {
    available: true,
    fee: 0n,
    feeMode: 'off',
    minFunding: 5_000_000n,
    pressure: 0,
    maxLockDays: 45,
    reason: null,
  }
  prepared?: Transaction
  submitted = 0
  prepares = 0

  async quote() {
    if (this.mode === 'unavailable') throw new GatewayError(503, 'sponsorship is unavailable')
    return this.terms
  }

  async prepare(kind: string, request: Record<string, string | number>): Promise<Prepared> {
    expect(kind).toBe('onboard')
    if (this.mode === 'unavailable') throw new GatewayError(503, 'sponsorship is unavailable')
    this.prepares++
    const wallet = address(request.wallet as string)
    const key = hexToBytes(request.key as string)
    const walletBytes = getAddressEncoder().encode(wallet) as Uint8Array
    let binding = {
      key,
      signature: hexToBytes(request.signature as string),
      envelope: deviceBindingEnvelope(DEVICE_DOMAIN, walletBytes, key),
    }
    if (this.mode === 'own-key') {
      const secret = p256.utils.randomSecretKey()
      const own = p256.getPublicKey(secret, true)
      const envelope = deviceBindingEnvelope(DEVICE_DOMAIN, walletBytes, own)
      binding = { key: own, signature: p256.sign(envelope, secret, { prehash: true, lowS: true }), envelope }
    }
    const {
      value: { blockhash, lastValidBlockHeight },
    } = await cluster.rpc.getLatestBlockhash().send()
    const computeUnitPrice = this.mode === 'price' ? MAX_SPONSORED_PRIORITY_FEE + 1n : 5_000n
    const sponsorFee = this.mode === 'unquoted-fee' ? this.terms.fee + 1n : this.terms.fee
    const sponsored = await buildOnboardTransaction(
      {
        programAddress: BUCKSPAY_PROGRAM_ADDRESS,
        feePayer: SPONSOR,
        blockhash,
        lastValidBlockHeight,
        computeUnitLimit: 60_000,
        computeUnitPrice,
      },
      {
        wallet,
        key: binding.key,
        binding,
        funder: address(request.funder as string),
        mint: MINT,
        tokenProgram: TOKEN_PROGRAM,
        bond: BigInt(request.bond),
        backing: BigInt(request.backing),
        lockUntil: Number(request.lockUntil),
        sponsorFee,
        sponsorToken: sponsorFee > 0n ? await associatedTokenAddress(SPONSOR, MINT, TOKEN_PROGRAM) : undefined,
      },
    )
    this.prepared = this.mode === 'transfer' ? withTransfer(sponsored, wallet) : sponsored
    return {
      transaction: getBase64EncodedWireTransaction(this.prepared),
      feePayer: this.mode === 'unparsable' ? 'not-an-address' : SPONSOR,
      blockhash,
      computeUnitLimit: 60_000,
      computeUnitPrice: Number(computeUnitPrice),
      sponsorFee,
      // Not part of what the gateway answers; the app must ignore it.
      ...(this.mode === 'silent' && { lastValidBlockHeight: Number.MAX_SAFE_INTEGER }),
    }
  }

  async submit(kind: string, { transaction }: { key: string; transaction: string }) {
    expect(kind).toBe('onboard')
    if (this.mode === 'refuses') throw new GatewayError(410, 'no prepared transaction for this key')
    if (this.mode === 'rejects') throw new GatewayError(422, 'Solana refused the transaction in its preflight')
    if (this.mode === 'silent') throw new TypeError('Network request failed')
    const signed = getTransactionDecoder().decode(getBase64Encoder().encode(transaction))
    expect(signed.messageBytes).toEqual(this.prepared!.messageBytes)
    this.submitted++
    const signature = getBase58Decoder().decode(await cluster.land(signed))
    if (this.mode === 'lost') throw new GatewayError(502, 'Bad Gateway')
    return { signature }
  }

  async rotationPending() {
    return { pending: false as const }
  }
}

/** The same transaction with a transfer of 2 SOL from the wallet to a thief appended. */
function withTransfer(transaction: Transaction, from: Address): Transaction {
  const message = decompileTransactionMessage(getCompiledTransactionMessageDecoder().decode(transaction.messageBytes))
  return compileTransaction(
    appendTransactionMessageInstruction(
      {
        programAddress: address('11111111111111111111111111111111'),
        accounts: [
          { address: from, role: AccountRole.WRITABLE_SIGNER },
          { address: THIEF, role: AccountRole.WRITABLE },
        ],
        data: new Uint8Array([2, 0, 0, 0, 0, 148, 53, 119, 0, 0, 0, 0]),
      },
      message,
    ),
  )
}

const context = (): IdentityContext => ({
  cluster: 'devnet',
  chain: CHAIN,
  cache,
  rpc: cluster.rpc,
  connect,
  disconnect,
  getTransactionSigner: signer,
  signTransactions,
  gateway,
  programAddress: BUCKSPAY_PROGRAM_ADDRESS,
  windows: WINDOWS,
  mint: MINT,
  onProgress: progress,
})

async function walk(...expected: IdentityState['step'][]) {
  let state = await resolveIdentity(context())
  const steps = [state.step]
  while (state.step !== 'ready' && steps.length < expected.length) {
    state = await advanceIdentity(context(), state)
    expect(state.error).toBeUndefined()
    steps.push(state.step)
    // Every step is what a relaunch derives from scratch.
    expect((await resolveIdentity(context())).step).toBe(state.step)
  }
  expect(steps).toEqual(expected)
  return state
}

/**
 * Runs `work`, moving the clock to each timer it waits for. Without one it awaits real work
 * (WebCrypto), which takes no simulated time.
 */
async function polled<T>(work: Promise<T>): Promise<T> {
  const done: { outcome?: { value: T } | { error: unknown } } = {}
  void work.then(
    (value) => (done.outcome = { value }),
    (error: unknown) => (done.outcome = { error }),
  )
  while (!done.outcome) {
    if (vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync()
    else await new Promise((resolve) => setImmediate(resolve))
  }
  if ('error' in done.outcome) throw done.outcome.error
  return done.outcome.value
}

/** Starts an activation and kills the app while the wallet holds it, once the cluster has it. */
async function killedWhileTheWalletHoldsIt(atActivate: IdentityState) {
  walletFailure = 'killed'
  void advanceIdentity(context(), atActivate)
  while (cluster.processed.length === 0) await new Promise((resolve) => setImmediate(resolve))
  await cluster.processed[0]
  walletFailure = 'none'
}

describe('device identity', () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    resetHardwareKeys()
    resetAsyncStorage()
    configureDeviceKey('devnet')
    cluster = new Cluster()
    wallet = ALICE
    walletFailure = 'none'
    walletCalls = 0
    gateway = undefined
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('walks a fresh install from connect to ready, resumable at every step', async () => {
    const createKey = vi.spyOn(HardwareKeys, 'createKey').mockClear()
    const ready = await walk('connect', 'create-key', 'activate', 'ready')
    expect(ready.wallet).toBe(ALICE)
    expect(ready.device?.wallet).toBe(ALICE)
    expect(ready.device?.key).toEqual(ready.deviceKey?.publicKey)
    expect(createKey).toHaveBeenCalledTimes(1)
    expect(cluster.simulated).toBe(1)
    expect(cluster.sent).toHaveLength(1)
    expect(progress).toHaveBeenCalledExactlyOnceWith({
      step: 'confirming',
      wallet: ALICE,
      deviceKey: ready.deviceKey,
      signature: expect.any(String),
    })
    expect(storedItems()).not.toHaveProperty('activation')
    expect(storedItems()['device-key:cluster']).toBe('devnet')
    expect(JSON.parse(storedItems().device)).toEqual({
      chain: CHAIN,
      address: ready.device?.address,
      wallet: ALICE,
      key: bytesToHex(ready.deviceKey!.publicKey),
    })
  })

  it('shows what activating costs and holds, and refuses what the wallet cannot pay without asking the wallet', async () => {
    const atActivate = await walk('connect', 'create-key', 'activate')
    expect(atActivate.activation).toMatchObject({
      sol: { balance: 2_000_000_000n, cost: COST },
      funding: { mint: MINT, decimals: 6, balance: 100_000_000n },
      defaultAmount: 5_000_000n,
      defaultLockDays: 30,
    })
    cluster.balances.set(ALICE, 1_000_000n)
    const short = await advanceIdentity(context(), atActivate)
    expect(short).toEqual({
      ...atActivate,
      activation: { ...atActivate.activation, sol: { balance: 1_000_000n, cost: COST } },
      error: `Your wallet has 0.001 SOL and activating costs about ${formatSol(COST, 'up')} SOL in network costs. Add SOL to your wallet, then try again. Nothing was sent.`,
    })
    expect(walletCalls).toBe(0)
    expect(storedItems()).not.toHaveProperty('activation')
    cluster.balances.set(ALICE, COST)
    expect((await advanceIdentity(context(), short)).step).toBe('ready')
  })

  it('refuses funds the wallet does not hold, and a lock outside the allowed days, before asking the wallet', async () => {
    const atActivate = await walk('connect', 'create-key', 'activate')
    await cluster.fund(ALICE, 3_000_000n)
    const poor = await advanceIdentity(context(), atActivate, { amount: 5_000_000n, lockDays: 30 })
    expect(poor.error).toBe(
      'Your wallet has 3 USDC and this needs 5 USDC. Add USDC to your wallet, then try again. Nothing was sent.',
    )
    const short = await advanceIdentity(context(), atActivate, { amount: 1_000_000n, lockDays: 400 })
    expect(short.error).toBe('Choose a lock of 15 to 365 days. Nothing was sent.')
    const none = await advanceIdentity(context(), atActivate, { amount: 0n, lockDays: 30 })
    expect(none.error).toBe('Enter an amount to add. Nothing was sent.')
    expect(walletCalls).toBe(0)
    expect(cluster.sent).toHaveLength(0)
  })

  it('creates a lock of the chosen funds, split between bond and backing, in the same transaction', async () => {
    const atActivate = await walk('connect', 'create-key', 'activate')
    const before = Date.now()
    await advanceIdentity(context(), atActivate, { amount: 10_000_000n, lockDays: 20 })
    const instructions = instructionsOf(cluster.sent[0])
    expect(instructions).toHaveLength(4)
    const lock = getCreateLockInstructionDataDecoder().decode(instructions[3].data!)
    expect([lock.bond, lock.backing, lock.sponsorFee]).toEqual([4_000_000n, 6_000_000n, 0n])
    expect(lock.lockUntil).toBe(Math.floor(before / 1000) + 20 * 86_400)
  })

  it('refuses an activation Solana would reject before the wallet sees it', async () => {
    const atActivate = await walk('connect', 'create-key', 'activate')
    cluster.simulationError = { InstructionError: [2, { Custom: 6001 }] }
    expect(await advanceIdentity(context(), atActivate)).toEqual({
      ...atActivate,
      error: 'Solana didn’t accept this phone’s key signature. Nothing was sent and nothing was charged.',
      details: '{"InstructionError":[2,{"Custom":6001}]}',
    })
    expect(cluster.simulated).toBe(1)
    expect(walletCalls).toBe(0)
    expect(storedItems()).not.toHaveProperty('activation')
  })

  it('never creates a key or activates again once they exist', async () => {
    await walk('connect', 'create-key', 'activate', 'ready')
    const createKey = vi.spyOn(HardwareKeys, 'createKey').mockClear()
    const state = await resolveIdentity(context())
    expect(state.step).toBe('ready')
    expect(await advanceIdentity(context(), state)).toEqual(state)
    expect(createKey).not.toHaveBeenCalled()
    expect(cluster.sent).toHaveLength(1)
  })

  it('is ready offline from the device account it stored, and checks it again against Solana', async () => {
    const ready = await walk('connect', 'create-key', 'activate', 'ready')
    cluster.offline = true
    expect(await resolveIdentity(context())).toEqual(ready)
    expect(await resolveIdentity(context(), { refresh: true })).toEqual({
      step: 'unreachable',
      wallet: ALICE,
      deviceKey: ready.deviceKey,
      error: UNREACHABLE,
      details: 'Network request failed',
    })
    cluster.offline = false
    expect(await resolveIdentity(context(), { refresh: true })).toEqual(ready)
  })

  it('ignores a stored device account that is unreadable or not this key’s on this chain', async () => {
    const ready = await walk('connect', 'create-key', 'activate', 'ready')
    const stored = JSON.parse(storedItems().device)
    for (const record of [
      '{',
      'null',
      JSON.stringify({ ...stored, chain: 'solana:devnet' }),
      JSON.stringify({ ...stored, key: `02${'00'.repeat(32)}` }),
      JSON.stringify({ ...stored, wallet: 'not an address' }),
    ]) {
      await AsyncStorage.setItem('device', record)
      cluster.offline = true
      expect((await resolveIdentity(context())).step).toBe('unreachable')
      cluster.offline = false
      expect(await resolveIdentity(context())).toEqual(ready)
      expect(JSON.parse(storedItems().device)).toEqual(stored)
    }
  })

  it('says when it cannot reach Solana, and reads the activation again on the next step', async () => {
    const atActivate = await walk('connect', 'create-key', 'activate')
    cluster.offline = true
    const unreachable = await resolveIdentity(context())
    expect(unreachable).toEqual({
      step: 'unreachable',
      wallet: ALICE,
      deviceKey: atActivate.deviceKey,
      error: UNREACHABLE,
      details: 'Network request failed',
    })
    cluster.offline = false
    expect(await advanceIdentity(context(), unreachable)).toEqual(atActivate)
  })

  it('keeps this phone’s key and registration without a wallet', async () => {
    const ready = await walk('connect', 'create-key', 'activate', 'ready')
    await disconnect()
    const forgotten = { step: 'connect', deviceKey: ready.deviceKey, device: ready.device }
    expect(await resolveIdentity(context())).toEqual(forgotten)
    await AsyncStorage.removeItem('device')
    expect(await resolveIdentity(context())).toEqual(forgotten)
    cluster.offline = true
    await AsyncStorage.removeItem('device')
    expect(await resolveIdentity(context())).toEqual({ step: 'connect', deviceKey: ready.deviceKey })
  })

  it('skips activation when this key is already bound to the wallet', async () => {
    await walk('connect', 'create-key', 'activate')
    await cluster.bind((await getDeviceKey())!.publicKey, ALICE)
    expect((await resolveIdentity(context())).step).toBe('ready')
    expect(cluster.sent).toHaveLength(0)
  })

  it('reads the device account again before it sends an activation', async () => {
    const atActivate = await walk('connect', 'create-key', 'activate')
    await cluster.bind((await getDeviceKey())!.publicKey, ALICE)
    expect(await advanceIdentity(context(), atActivate)).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(cluster.sent).toHaveLength(0)
  })

  it('shows a key bound to another wallet, and connects another wallet without activating', async () => {
    await walk('connect', 'create-key', 'activate')
    await cluster.bind((await getDeviceKey())!.publicKey, BOB)
    const state = await resolveIdentity(context())
    expect(state).toMatchObject({ step: 'other-wallet', wallet: ALICE, device: { wallet: BOB } })
    expect(state.error).toBeUndefined()
    wallet = BOB
    const switched = await advanceIdentity(context(), state)
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(switched).toMatchObject({ step: 'ready', wallet: BOB })
    expect(cluster.sent).toHaveLength(0)
  })

  it('records an activation before the wallet holds it, and confirms it after the app was killed', async () => {
    const atActivate = await walk('connect', 'create-key', 'activate')
    cluster.landing = 'later'
    await killedWhileTheWalletHoldsIt(atActivate)
    const { publicKey } = (await getDeviceKey())!
    expect(JSON.parse(storedItems().activation)).toEqual({
      chain: CHAIN,
      key: bytesToHex(publicKey),
      wallet: ALICE,
      lastValidBlockHeight: '150',
    })
    // Fake timers never advance here: a wait would never end.
    const confirming = await resolveIdentity(context())
    expect(confirming).toEqual({ step: 'confirming', wallet: ALICE, deviceKey: atActivate.deviceKey })
    expect(await polled(advanceIdentity(context(), confirming))).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(storedItems()).not.toHaveProperty('activation')
    expect(cluster.sent).toHaveLength(1)
  })

  it('waits for an activation the wallet sent before it reported an error', async () => {
    const atActivate = await walk('connect', 'create-key', 'activate')
    cluster.landing = 'later'
    walletFailure = 'after-sending'
    const sent = await polled(advanceIdentity(context(), atActivate))
    expect(sent).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(sent.error).toBeUndefined()
    expect(progress).toHaveBeenCalledExactlyOnceWith({
      step: 'confirming',
      wallet: ALICE,
      deviceKey: atActivate.deviceKey,
    })
    expect(storedItems()).not.toHaveProperty('activation')
    expect(cluster.sent).toHaveLength(1)
  })

  it('reports a declined activation at once, and another wallet error once it can no longer land', async () => {
    const atActivate = await walk('connect', 'create-key', 'activate')
    walletFailure = 'declined'
    // Fake timers never advance here: a wait would never end.
    expect(await advanceIdentity(context(), atActivate)).toEqual({
      ...atActivate,
      error: 'You declined in your wallet. Nothing was sent and nothing was charged.',
      details: 'User declined',
    })
    expect(storedItems()).not.toHaveProperty('activation')
    walletFailure = 'before-sending'
    expect(await polled(advanceIdentity(context(), atActivate))).toEqual({
      ...atActivate,
      error: 'The activation didn’t go through. Nothing was charged and this phone is not activated. Try again.',
      details: 'The wallet closed the session.',
    })
    expect(storedItems()).not.toHaveProperty('activation')
    expect(cluster.sent).toHaveLength(0)
  })

  it('reports a sent activation that expired and offers it again', async () => {
    const atActivate = await walk('connect', 'create-key', 'activate')
    cluster.landing = 'never'
    const expired = await polled(advanceIdentity(context(), atActivate))
    expect(expired).toEqual({ ...atActivate, error: EXPIRED })
    expect(storedItems()).not.toHaveProperty('activation')
    cluster.landing = 'now'
    expect((await advanceIdentity(context(), expired)).step).toBe('ready')
    expect(cluster.sent).toHaveLength(2)
  })

  it('reports at once a failure the cluster confirms for the signature the wallet returned', async () => {
    const atActivate = await walk('connect', 'create-key', 'activate')
    cluster.landing = 'fails'
    const failed = await polled(advanceIdentity(context(), atActivate))
    expect(failed).toEqual({
      ...atActivate,
      error: 'Solana didn’t accept this phone’s key signature. No funds moved, and this phone is not activated.',
      details: '{"InstructionError":[2,{"Custom":6001}]}',
      signature: getBase58Decoder().decode(await cluster.processed[0]),
    })
    // Its blockhash is still valid: the wait ended at the first status read.
    expect(cluster.blockHeight).toBeLessThan(150n)
    expect(storedItems()).not.toHaveProperty('activation')
  })

  it('stops waiting by block height while the device account cannot be read, and keeps the record', async () => {
    const atActivate = await walk('connect', 'create-key', 'activate')
    cluster.landing = 'never'
    await killedWhileTheWalletHoldsIt(atActivate)
    cluster.accountsUnavailable = true
    const confirming = await resolveIdentity(context())
    const unconfirmed = await polled(advanceIdentity(context(), confirming))
    expect(unconfirmed).toEqual({ ...confirming, error: UNCONFIRMED, details: 'Network request failed' })
    expect(storedItems()).toHaveProperty('activation')
    cluster.accountsUnavailable = false
    expect(await advanceIdentity(context(), unconfirmed)).toEqual({ ...atActivate, error: EXPIRED })
    expect(storedItems()).not.toHaveProperty('activation')
  })

  it('reads the device account at the slot of the block height it read, on an RPC whose nodes lag', async () => {
    const atActivate = await walk('connect', 'create-key', 'activate')
    cluster.landing = 'later'
    // Account reads reach a lagging node until after the blockhash expired.
    cluster.lagging = 10
    walletFailure = 'after-sending'
    const unconfirmed = await polled(advanceIdentity(context(), atActivate))
    expect(unconfirmed).toMatchObject({ step: 'confirming', error: STALLED })
    expect(storedItems()).toHaveProperty('activation')
    walletFailure = 'none'
    expect(await polled(advanceIdentity(context(), unconfirmed))).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(cluster.sent).toHaveLength(1)
  })

  it('stops waiting after three minutes while the block height does not move, and keeps the record', async () => {
    const atActivate = await walk('connect', 'create-key', 'activate')
    cluster.landing = 'never'
    await killedWhileTheWalletHoldsIt(atActivate)
    cluster.stalled = true
    const confirming = await resolveIdentity(context())
    const started = Date.now()
    const stalled = await polled(advanceIdentity(context(), confirming))
    expect(stalled).toEqual({ ...confirming, error: STALLED })
    expect(Date.now() - started).toBe(180_000)
    expect(storedItems()).toHaveProperty('activation')
    cluster.stalled = false
    expect(await polled(advanceIdentity(context(), stalled))).toEqual({ ...atActivate, error: EXPIRED })
    expect(storedItems()).not.toHaveProperty('activation')
  })

  it('drops a stored activation that is unreadable, of an older shape or of another chain', async () => {
    const atActivate = await walk('connect', 'create-key', 'activate')
    const { publicKey } = (await getDeviceKey())!
    const current = { chain: CHAIN, key: bytesToHex(publicKey), wallet: ALICE, lastValidBlockHeight: '500' }
    const signature = getBase58Decoder().decode(new Uint8Array(64).fill(1))
    for (const stored of [
      '{',
      'null',
      '7',
      JSON.stringify({ chain: CHAIN, signature, lastValidBlockHeight: '500' }),
      JSON.stringify({ ...current, key: 'device' }),
      JSON.stringify({ ...current, lastValidBlockHeight: 500 }),
      JSON.stringify({ ...current, chain: 'solana:devnet' }),
    ]) {
      await AsyncStorage.setItem('activation', stored)
      expect(await resolveIdentity(context())).toEqual(atActivate)
      expect(storedItems()).not.toHaveProperty('activation')
    }
  })

  it('creates and activates a key only for the cluster this build signs for', async () => {
    const atKey = await walk('connect', 'create-key')
    const mainnet = { ...context(), cluster: 'mainnet' as const }
    expect((await advanceIdentity(mainnet, atKey)).error).toBe(
      'This phone’s key is set up for devnet, and this app for mainnet. Nothing was created, sent or charged.',
    )
    expect(await getDeviceKey()).toBeNull()
    const atActivate = await advanceIdentity(context(), atKey)
    await AsyncStorage.setItem('device-key:cluster', 'mainnet')
    expect((await advanceIdentity(context(), atActivate)).error).toBe(
      'This phone’s key was created for mainnet, and this app signs for devnet. Nothing was sent or charged.',
    )
    expect(cluster.sent).toHaveLength(0)
  })

  it('limits a registration to the most expensive one at the bump of its key, and to at least 40,000 CU', () => {
    expect([255, 239, 238, 235, 0].map((bump) => registerDeviceComputeUnitLimit(bump))).toEqual([
      40_000, 40_000, 41_276, 45_776, 398_276,
    ])
  })

  it('reports a wallet that declines to connect as a declined connection', async () => {
    connect.mockImplementationOnce(async () => {
      throw new SolanaMobileWalletAdapterProtocolError(0, -1, 'authorization request declined')
    })
    expect(await advanceIdentity(context(), await resolveIdentity(context()))).toEqual({
      step: 'connect',
      error: 'The wallet declined the connection. Nothing was shared and nothing was charged.',
      details: 'authorization request declined',
    })
    expect(disconnect).not.toHaveBeenCalled()
    await walk('connect', 'create-key')
  })

  it('clears an authorization the wallet forgot and reconnects', async () => {
    const atActivate = await walk('connect', 'create-key', 'activate')
    walletFailure = 'revoked'
    const revoked = await advanceIdentity(context(), atActivate)
    expect(revoked).toMatchObject({ step: 'connect', error: expect.stringContaining('Connect it again') })
    expect(await cache.get()).toBeUndefined()
    expect(storedItems()).not.toHaveProperty('activation')
    walletFailure = 'none'
    await walk('connect', 'activate', 'ready')
  })

  it('says what happened and whether anything moved for each kind of failure', () => {
    const refused = (code: number, message: string) => new SolanaMobileWalletAdapterProtocolError(0, code, message)
    const missing = new SolanaMobileWalletAdapterError(
      SolanaMobileWalletAdapterErrorCode.ERROR_WALLET_NOT_FOUND,
      'Found no installed wallet that supports the mobile wallet protocol.',
    )
    const offline = new TypeError('Network request failed')
    expect(
      [
        describeIdentityError(refused(-3, 'declined'), 'activate'),
        describeIdentityError(refused(-1, 'declined'), 'connect'),
        describeIdentityError(refused(-1, 'revoked'), 'activate'),
        describeIdentityError(refused(-4, 'not submitted'), 'activate'),
        describeIdentityError(missing, 'connect'),
        describeIdentityError(offline, 'activate'),
        describeIdentityError(offline, 'confirming'),
        describeIdentityError(new Error('Keystore failed'), 'create-key'),
      ].map(({ error }) => error),
    ).toEqual([
      'You declined in your wallet. Nothing was sent and nothing was charged.',
      'The wallet declined the connection. Nothing was shared and nothing was charged.',
      'Your wallet no longer recognizes Buckspay. Nothing was sent and nothing was charged. Connect it again.',
      'Your wallet couldn’t send the activation. Nothing was charged and this phone is not activated. Try again.',
      'No wallet app on this phone works with Buckspay. Install Phantom or Solflare, then try again.',
      UNREACHABLE,
      UNCONFIRMED,
      'This phone couldn’t create its key. Nothing was charged. Try again.',
    ])
    expect(describeIdentityError(missing, 'connect').details).toBe(missing.message)
  })

  it('activates for free: the wallet only signs, and the gateway pays and sends', async () => {
    const sponsor = (gateway = new Gateway())
    cluster.balances.set(ALICE, 0n)
    const atActivate = await walk('connect', 'create-key', 'activate')
    expect(atActivate.sponsorship).toBe('free')
    const ready = await advanceIdentity(context(), atActivate)
    expect(ready).toMatchObject({ step: 'ready', wallet: ALICE, device: { wallet: ALICE } })
    expect(walletCalls).toBe(1)
    expect(sponsor.submitted).toBe(1)
    // One approval covers the registration and the funding: both are in the one transaction.
    expect(instructionsOf(cluster.sent[0])).toHaveLength(5)
    const { staticAccounts } = getCompiledTransactionMessageDecoder().decode(cluster.sent[0].messageBytes)
    expect(staticAccounts.slice(0, 2)).toEqual([SPONSOR, ALICE])
    expect(progress).toHaveBeenCalledExactlyOnceWith({
      step: 'confirming',
      wallet: ALICE,
      deviceKey: ready.deviceKey,
      signature: expect.any(String),
    })
    expect(storedItems()).not.toHaveProperty('activation')
  })

  it.each([
    ['own-key', 'Buckspay’s server offered an activation this app didn’t ask for'],
    ['transfer', 'Buckspay’s server offered an activation this app didn’t ask for'],
    ['price', 'Buckspay’s server offered an activation this app didn’t ask for'],
    ['unquoted-fee', 'Buckspay’s server offered an activation this app didn’t ask for'],
    ['unparsable', 'Buckspay’s server offered an activation this app didn’t ask for'],
    ['refuses', 'Buckspay couldn’t pay for this activation.'],
    ['rejects', 'Buckspay couldn’t pay for this activation.'],
  ] as const)(
    'never shows the wallet an activation the gateway changed, and offers to pay instead (%s)',
    async (mode, error) => {
      const sponsor = (gateway = new Gateway())
      const atActivate = await walk('connect', 'create-key', 'activate')
      sponsor.mode = mode
      const refused = await advanceIdentity(context(), atActivate)
      expect(refused).toMatchObject({ step: 'activate', sponsorship: 'unavailable', activation: atActivate.activation })
      expect(refused.error).toContain(error)
      expect(refused.error).toContain(
        'Nothing was sent and nothing was charged. You can activate now and pay the network costs from your wallet.',
      )
      // The wallet signs only what the app built: the gateway refused it after the wallet signed.
      expect(walletCalls).toBe(mode === 'refuses' || mode === 'rejects' ? 1 : 0)
      expect(sponsor.submitted).toBe(0)
      expect(cluster.sent).toHaveLength(0)
      expect(storedItems()).not.toHaveProperty('activation')
      // The next tap registers with the wallet paying, as the screen now says.
      expect(await advanceIdentity(context(), refused)).toMatchObject({ step: 'ready', wallet: ALICE })
      const { staticAccounts } = getCompiledTransactionMessageDecoder().decode(cluster.sent[0].messageBytes)
      expect(staticAccounts[0]).toBe(ALICE)
    },
  )

  it.each([
    ['can pay', 2_000_000_000n, 'You can activate now and pay the network costs from your wallet.'],
    ['cannot pay', 0n, 'To activate now, add SOL to your wallet and pay from it.'],
  ] as const)(
    'falls back when Buckspay’s activation would fail, and says whether the wallet %s instead',
    async (_, balance, instead) => {
      const sponsor = (gateway = new Gateway())
      cluster.balances.set(ALICE, balance)
      const atActivate = await walk('connect', 'create-key', 'activate')
      // What simulating the gateway's transaction gives once its fee payer ran dry.
      cluster.simulationError = 'InsufficientFundsForFee'
      const refused = await advanceIdentity(context(), atActivate)
      expect(refused).toMatchObject({ step: 'activate', sponsorship: 'unavailable', activation: atActivate.activation })
      expect(refused.error).toBe(
        `Buckspay couldn’t pay for this activation. Nothing was sent and nothing was charged. ${instead}`,
      )
      expect(walletCalls).toBe(0)
      expect(sponsor.submitted).toBe(0)
    },
  )

  it('waits for an activation the gateway may have sent when a proxy answers for it', async () => {
    const sponsor = (gateway = new Gateway())
    const atActivate = await walk('connect', 'create-key', 'activate')
    sponsor.mode = 'lost'
    expect(await advanceIdentity(context(), atActivate)).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(sponsor.submitted).toBe(1)
    expect(cluster.sent).toHaveLength(1)
  })

  it('waits past its own RPC’s lifetime for a gateway whose RPC is ahead', async () => {
    const sponsor = (gateway = new Gateway())
    const atActivate = await walk('connect', 'create-key', 'activate')
    // The activation lands only after the app's own blockhash (50 blocks, 20 a read) expired.
    sponsor.mode = 'lost'
    cluster.landing = 'later'
    cluster.laterReads = 5
    expect(await polled(advanceIdentity(context(), atActivate))).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(cluster.sent).toHaveLength(1)
  })

  it('waits for an unanswered submission only as long as its own RPC says it can land', async () => {
    const sponsor = (gateway = new Gateway())
    const atActivate = await walk('connect', 'create-key', 'activate')
    sponsor.mode = 'silent'
    const expired = await polled(advanceIdentity(context(), atActivate))
    expect(expired).toMatchObject({ step: 'activate', error: EXPIRED })
    expect(storedItems()).not.toHaveProperty('activation')
  })

  it('has the wallet pay when the gateway does not offer to', async () => {
    const sponsor = (gateway = new Gateway())
    sponsor.mode = 'unavailable'
    const atActivate = await walk('connect', 'create-key', 'activate')
    expect(atActivate.sponsorship).toBe('unavailable')
    expect(await advanceIdentity(context(), atActivate)).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(sponsor.submitted).toBe(0)
    const { staticAccounts } = getCompiledTransactionMessageDecoder().decode(cluster.sent[0].messageBytes)
    expect(staticAccounts[0]).toBe(ALICE)
  })

  it.each([
    ['unsupported', 'Your wallet can’t sign an activation that Buckspay pays for.'],
    ['altered', 'Your wallet changed the activation before signing it, so it wasn’t sent.'],
  ] as const)('offers to pay from the wallet when it cannot sign for a sponsor (%s)', async (failure, error) => {
    const sponsor = (gateway = new Gateway())
    const atActivate = await walk('connect', 'create-key', 'activate')
    walletFailure = failure
    const refused = await advanceIdentity(context(), atActivate)
    expect(refused).toMatchObject({ step: 'activate', sponsorship: 'unavailable' })
    expect(refused.error).toContain(error)
    expect(sponsor.submitted).toBe(0)
    expect(storedItems()).not.toHaveProperty('activation')
    walletFailure = 'none'
    expect(await advanceIdentity(context(), refused)).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(sponsor.submitted).toBe(0)
  })

  it('offers an unfunded wallet the paid path when its answer has one signature where two are required', async () => {
    const sponsor = (gateway = new Gateway())
    cluster.balances.set(ALICE, 0n)
    const atActivate = await walk('connect', 'create-key', 'activate')
    expect(atActivate.sponsorship).toBe('free')
    walletFailure = 'one-signature'
    const refused = await advanceIdentity(context(), atActivate)
    expect(refused).toMatchObject({ step: 'activate', sponsorship: 'unavailable' })
    expect(refused.error).toBe(onboardingCopy.walletChangedTransaction)
    expect(refused.details).toContain('expected the transaction to have 2 signatures, got 1')
    expect(sponsor.submitted).toBe(0)
    expect(cluster.sent).toHaveLength(0)
    expect(storedItems()).not.toHaveProperty('activation')
  })

  it('sends nothing when the wallet declines a sponsored activation, or is killed while it holds it', async () => {
    const sponsor = (gateway = new Gateway())
    const atActivate = await walk('connect', 'create-key', 'activate')
    walletFailure = 'declined'
    expect(await advanceIdentity(context(), atActivate)).toEqual({
      ...atActivate,
      error: 'You declined in your wallet. Nothing was sent and nothing was charged.',
      details: 'User declined',
    })
    walletFailure = 'killed'
    void advanceIdentity(context(), atActivate)
    while (walletCalls < 2) await new Promise((resolve) => setImmediate(resolve))
    // The app was killed: a relaunch offers the free activation again, with nothing to wait for.
    expect(await resolveIdentity(context())).toEqual(atActivate)
    expect(sponsor.submitted).toBe(0)
    expect(storedItems()).not.toHaveProperty('activation')
  })

  it('clears an authorization the wallet forgot while it signs for a sponsor', async () => {
    gateway = new Gateway()
    const atActivate = await walk('connect', 'create-key', 'activate')
    walletFailure = 'revoked'
    const revoked = await advanceIdentity(context(), atActivate)
    expect(revoked).toMatchObject({ step: 'connect', error: expect.stringContaining('Connect it again') })
    expect(await cache.get()).toBeUndefined()
    walletFailure = 'none'
    await walk('connect', 'activate', 'ready')
  })

  it('a wallet that rewrites the onboarding message fails cleanly for a zero-SOL user', async () => {
    const sponsor = (gateway = new Gateway())
    cluster.balances.set(ALICE, 0n)
    const atActivate = await walk('connect', 'create-key', 'activate')
    const key = (await getDeviceKey())!.publicKey
    for (const failure of ['appends', 'budget', 'reorders'] as const) {
      walletFailure = failure
      const refused = await advanceIdentity(context(), atActivate)
      expect(refused.error).toBe(onboardingCopy.walletChangedTransaction)
      // No self-pay offer: the wallet cannot cover the network costs.
      expect(refused.activation!.sol.balance).toBeLessThan(refused.activation!.sol.cost)
      expect(refused).toMatchObject({ step: 'activate', sponsorship: 'unavailable' })
      expect(sponsor.submitted).toBe(0)
      expect(cluster.sent).toHaveLength(0)
      // Back to the not-activated state with the same key, and nothing stored to resume.
      expect(storedItems()).not.toHaveProperty('activation')
      expect((await getDeviceKey())!.publicKey).toEqual(key)
      expect((await resolveIdentity(context())).step).toBe('activate')
    }
    // A conforming wallet activates through the gateway.
    walletFailure = 'none'
    const fresh = await resolveIdentity(context())
    expect(await advanceIdentity(context(), fresh)).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(sponsor.submitted).toBe(1)
  })

  it('offers the self-paid transaction first to a wallet with enough SOL that rewrites the message', async () => {
    const sponsor = (gateway = new Gateway())
    cluster.balances.set(ALICE, 10_000_000n)
    const atActivate = await walk('connect', 'create-key', 'activate')
    walletFailure = 'appends'
    const refused = await advanceIdentity(context(), atActivate)
    expect(refused.error).toBe(
      'Your wallet changed the activation before signing it, so it wasn’t sent. Nothing was sent and nothing was charged. You can activate now and pay the network costs from your wallet.',
    )
    expect(refused.activation!.sol.balance).toBeGreaterThanOrEqual(refused.activation!.sol.cost)
    walletFailure = 'none'
    expect(await advanceIdentity(context(), refused)).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(sponsor.submitted).toBe(0)
    expect(getCompiledTransactionMessageDecoder().decode(cluster.sent[0].messageBytes).staticAccounts[0]).toBe(ALICE)
  })

  it('shows a quoted fee before anything else when the lever is on, and charges only that', async () => {
    const sponsor = (gateway = new Gateway())
    sponsor.terms = { ...sponsor.terms, fee: 150_000n, feeMode: 'cost_plus' }
    const atActivate = await walk('connect', 'create-key', 'activate')
    expect(atActivate.activation!.quote).toMatchObject({ fee: 150_000n, feeMode: 'cost_plus' })
    await cluster.fund(ALICE, 5_000_000n)
    const short = await advanceIdentity(context(), atActivate)
    expect(short.error).toBe(
      'Your wallet has 5 USDC and this needs 5.15 USDC. Add USDC to your wallet, then try again. Nothing was sent.',
    )
    expect(walletCalls).toBe(0)
    await cluster.fund(ALICE, 5_150_000n)
    expect(await advanceIdentity(context(), short)).toMatchObject({ step: 'ready', wallet: ALICE })
    const instructions = instructionsOf(cluster.sent[0])
    expect(getCreateLockInstructionDataDecoder().decode(instructions[4].data!).sponsorFee).toBe(150_000n)
  })

  it('asks again when the quoted terms changed after the screen showed them', async () => {
    const sponsor = (gateway = new Gateway())
    const atActivate = await walk('connect', 'create-key', 'activate')
    sponsor.terms = { ...sponsor.terms, fee: 90_000n, feeMode: 'cost_plus', minFunding: 10_000_000n }
    const changed = await advanceIdentity(context(), atActivate)
    expect(changed.error).toBe(
      'Buckspay’s terms changed while you were looking. Review them and try again. Nothing was sent.',
    )
    expect(changed.activation!.quote).toMatchObject({ fee: 90_000n, minFunding: 10_000_000n })
    expect(walletCalls).toBe(0)
    expect(sponsor.prepares).toBe(0)
  })

  it('has the wallet pay below the minimum Buckspay covers, and says it before the wallet is asked', async () => {
    const sponsor = (gateway = new Gateway())
    sponsor.terms = { ...sponsor.terms, minFunding: 50_000_000n, pressure: 90 }
    const atActivate = await walk('connect', 'create-key', 'activate')
    expect(atActivate.activation!.defaultAmount).toBe(50_000_000n)
    expect(await advanceIdentity(context(), atActivate, { amount: 10_000_000n, lockDays: 30 })).toMatchObject({
      step: 'ready',
    })
    expect(sponsor.prepares).toBe(0)
    expect(getCompiledTransactionMessageDecoder().decode(cluster.sent[0].messageBytes).staticAccounts[0]).toBe(ALICE)
  })
})
