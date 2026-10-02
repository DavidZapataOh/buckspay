import { p256 } from '@noble/curves/nist.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  BUCKSPAY_PROGRAM_ADDRESS,
  findDevicePda,
  getDeviceEncoder,
  getRegisterDeviceInstructionDataDecoder,
  registerDeviceComputeUnitLimit,
} from '@project/anchor'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  getSetComputeUnitLimitInstructionDataDecoder,
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
import { deviceBindingEnvelope, DEVNET_GENESIS_HASH, domain, Purpose } from '../../protocol'
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
import { GatewayError } from './gateway'
import { buildSponsoredTransaction, MAX_SPONSORED_PRIORITY_FEE } from './register-device'

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
/** The rent of a 41-byte device account and the fee of one transaction signature and one secp256r1 signature. */
const COST = 1_176_240n + 10_000n
const EXPIRED = 'The registration expired before it landed. Nothing was charged and this phone is not registered.'
const UNREACHABLE = 'Can’t reach Solana. Check your connection and try again. Nothing was sent.'
const UNCONFIRMED = 'Can’t reach Solana to check the registration. It may still land; check again once you’re online.'
const STALLED = 'Solana hasn’t confirmed the registration yet. It may still land; check again in a minute.'
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
 * A cluster that runs `register_device` the way the program does: it checks the secp256r1
 * verification against the binding it rebuilds, then creates the device account at `confirmed`. Its
 * slots are its block heights.
 */
class Cluster {
  accounts = new Map<Address, Uint8Array>()
  balances = new Map<Address, bigint>()
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
  /** The error a simulated registration fails with. */
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

  land(transaction: Transaction): Promise<SignatureBytes> {
    this.sent.push(transaction)
    const processed = this.process(transaction)
    this.processed.push(processed)
    return processed
  }

  /** The checks `register_device` makes, and the device account it would create. */
  private async check(transaction: Transaction) {
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes)
    if (message.version !== 0) throw new Error(`unexpected transaction version ${message.version}`)
    // A sponsored registration also sets a compute unit price, and its wallet is the second signer.
    const sponsored = message.instructions.length === 4
    const [budget, verify, register] = sponsored
      ? [message.instructions[0], ...message.instructions.slice(2)]
      : message.instructions
    expect(message.staticAccounts[budget.programAddressIndex]).toBe(COMPUTE_BUDGET_PROGRAM_ADDRESS)
    expect(message.staticAccounts[verify.programAddressIndex]).toBe(SECP256R1_PROGRAM_ADDRESS)
    expect(message.staticAccounts[register.programAddressIndex]).toBe(BUCKSPAY_PROGRAM_ADDRESS)
    const wallet = message.staticAccounts[sponsored ? 1 : 0]
    const { key } = getRegisterDeviceInstructionDataDecoder().decode(register.data!)
    const [device, bump] = await findDevicePda(key)
    const { units } = getSetComputeUnitLimitInstructionDataDecoder().decode(budget.data!)
    expect(units).toBe(registerDeviceComputeUnitLimit(bump))
    const data = verify.data!
    expect(data.slice(16, 49)).toEqual(key)
    expect(data.slice(113)).toEqual(
      deviceBindingEnvelope(DEVICE_DOMAIN, getAddressEncoder().encode(wallet) as Uint8Array, Uint8Array.from(key)),
    )
    expect(p256.verify(data.slice(49, 113), data.slice(113), data.slice(16, 49), { prehash: true, lowS: true })).toBe(
      true,
    )
    return { device, wallet, key }
  }

  private async process(transaction: Transaction): Promise<SignatureBytes> {
    const { device, wallet } = await this.check(transaction)
    const create = () => {
      if (this.accounts.has(device)) throw new Error('already in use')
      this.accounts.set(device, Uint8Array.from(getDeviceEncoder().encode({ wallet, bump: 255 })))
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
    this.accounts.set(device, Uint8Array.from(getDeviceEncoder().encode({ wallet, bump: 255 })))
  }
}

let cluster: Cluster
let wallet: Address
let walletFailure:
  'none' | 'revoked' | 'declined' | 'before-sending' | 'after-sending' | 'killed' | 'unsupported' | 'altered'
let gateway: Gateway | undefined
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
  const signatures = { ...transaction.signatures, [wallet]: new Uint8Array(64).fill(7) as SignatureBytes }
  if (failure === 'altered') {
    // A wallet that adds its own priority fee signs another message.
    const messageBytes = Uint8Array.from(transaction.messageBytes)
    messageBytes[messageBytes.length - 1] ^= 1
    return { ...transaction, messageBytes: messageBytes as unknown as Transaction['messageBytes'], signatures }
  }
  return { ...transaction, signatures }
}

const SPONSOR = address('2t2uAzmxvzM5caJZUeUd4Qg4Qcu39x978yoUzyher8fQ')
const THIEF = address('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')

/**
 * A gateway that pays for registrations as the Rust one does, or, as a compromised or broken one
 * could, offers another: one binding its own device key to the wallet, one with a transfer out of
 * the wallet appended, one above the price cap, or one it describes with an unparsable fee payer
 * and an endless lifetime. It refuses to send (`refuses`, `rejects`), sends and then a proxy in front
 * of it fails (`lost`), or never answers the submission (`silent`). A real gateway cannot be made to
 * misbehave, so these cases run against this double; everything Solana does runs on the validator
 * in the gateway's own tests.
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
    | 'unparsable' = 'honest'
  prepared?: Transaction
  submitted = 0

  async sponsorship() {
    if (this.mode === 'unavailable') throw new GatewayError(503, 'sponsorship is unavailable')
  }

  async prepare({ wallet: owner, key, signature }: { wallet: string; key: string; signature: string }) {
    if (this.mode === 'unavailable') throw new GatewayError(503, 'sponsorship is unavailable')
    const wallet = address(owner)
    const walletBytes = getAddressEncoder().encode(wallet) as Uint8Array
    let binding = {
      key: hexToBytes(key),
      signature: hexToBytes(signature),
      envelope: deviceBindingEnvelope(DEVICE_DOMAIN, walletBytes, hexToBytes(key)),
    }
    if (this.mode === 'own-key') {
      const secret = p256.utils.randomSecretKey()
      const own = p256.getPublicKey(secret, true)
      const envelope = deviceBindingEnvelope(DEVICE_DOMAIN, walletBytes, own)
      binding = { key: own, signature: p256.sign(envelope, secret, { prehash: true, lowS: true }), envelope }
    }
    const [device, bump] = await findDevicePda(binding.key)
    const {
      value: { blockhash, lastValidBlockHeight },
    } = await cluster.rpc.getLatestBlockhash().send()
    const computeUnitPrice = this.mode === 'price' ? MAX_SPONSORED_PRIORITY_FEE + 1n : 5_000n
    const sponsored = buildSponsoredTransaction(
      { binding, bump, device, wallet },
      { feePayer: SPONSOR, blockhash, lastValidBlockHeight, computeUnitPrice },
    )
    this.prepared = this.mode === 'transfer' ? withTransfer(sponsored, wallet) : sponsored
    return {
      transaction: getBase64EncodedWireTransaction(this.prepared),
      feePayer: this.mode === 'unparsable' ? 'not-an-address' : SPONSOR,
      blockhash,
      computeUnitPrice: Number(computeUnitPrice),
      // Not part of what the gateway answers; the app must ignore it.
      ...(this.mode === 'silent' && { lastValidBlockHeight: Number.MAX_SAFE_INTEGER }),
    }
  }

  async submit({ transaction }: { key: string; transaction: string }) {
    if (this.mode === 'refuses') throw new GatewayError(410, 'no prepared registration for this key')
    if (this.mode === 'rejects') throw new GatewayError(422, 'Solana refused the registration in its preflight')
    if (this.mode === 'silent') throw new TypeError('Network request failed')
    const signed = getTransactionDecoder().decode(getBase64Encoder().encode(transaction))
    expect(signed.messageBytes).toEqual(this.prepared!.messageBytes)
    this.submitted++
    const signature = getBase58Decoder().decode(await cluster.land(signed))
    if (this.mode === 'lost') throw new GatewayError(502, 'Bad Gateway')
    return { signature }
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

/** Starts a registration and kills the app while the wallet holds it, once the cluster has it. */
async function killedWhileTheWalletHoldsIt(atRegister: IdentityState) {
  walletFailure = 'killed'
  void advanceIdentity(context(), atRegister)
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
    const ready = await walk('connect', 'create-key', 'register', 'ready')
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
    expect(storedItems()).not.toHaveProperty('registration')
    expect(storedItems()['device-key:cluster']).toBe('devnet')
    expect(JSON.parse(storedItems().device)).toEqual({
      chain: CHAIN,
      address: ready.device?.address,
      wallet: ALICE,
      key: bytesToHex(ready.deviceKey!.publicKey),
    })
  })

  it('shows what registering costs, and refuses one the wallet cannot pay without asking the wallet', async () => {
    const atRegister = await walk('connect', 'create-key', 'register')
    expect(atRegister.quote).toEqual({ balance: 2_000_000_000n, cost: COST })
    cluster.balances.set(ALICE, 1_000_000n)
    const short = await advanceIdentity(context(), atRegister)
    expect(short).toEqual({
      ...atRegister,
      quote: { balance: 1_000_000n, cost: COST },
      error:
        'Your wallet has 0.001 SOL and registering costs about 0.0012 SOL. Add SOL to your wallet, then try again. Nothing was sent.',
    })
    expect(walletCalls).toBe(0)
    expect(storedItems()).not.toHaveProperty('registration')
    cluster.balances.set(ALICE, COST)
    expect((await advanceIdentity(context(), short)).step).toBe('ready')
  })

  it('refuses a registration Solana would reject before the wallet sees it', async () => {
    const atRegister = await walk('connect', 'create-key', 'register')
    cluster.simulationError = { InstructionError: [2, { Custom: 6001 }] }
    expect(await advanceIdentity(context(), atRegister)).toEqual({
      ...atRegister,
      error: 'Solana didn’t accept this phone’s key signature. Nothing was sent and nothing was charged.',
      details: '{"InstructionError":[2,{"Custom":6001}]}',
    })
    expect(cluster.simulated).toBe(1)
    expect(walletCalls).toBe(0)
    expect(storedItems()).not.toHaveProperty('registration')
  })

  it('never creates a key or registers again once they exist', async () => {
    await walk('connect', 'create-key', 'register', 'ready')
    const createKey = vi.spyOn(HardwareKeys, 'createKey').mockClear()
    const state = await resolveIdentity(context())
    expect(state.step).toBe('ready')
    expect(await advanceIdentity(context(), state)).toEqual(state)
    expect(createKey).not.toHaveBeenCalled()
    expect(cluster.sent).toHaveLength(1)
  })

  it('is ready offline from the device account it stored, and checks it again against Solana', async () => {
    const ready = await walk('connect', 'create-key', 'register', 'ready')
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
    const ready = await walk('connect', 'create-key', 'register', 'ready')
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

  it('says when it cannot reach Solana, and reads the registration again on the next step', async () => {
    const atRegister = await walk('connect', 'create-key', 'register')
    cluster.offline = true
    const unreachable = await resolveIdentity(context())
    expect(unreachable).toEqual({
      step: 'unreachable',
      wallet: ALICE,
      deviceKey: atRegister.deviceKey,
      error: UNREACHABLE,
      details: 'Network request failed',
    })
    cluster.offline = false
    expect(await advanceIdentity(context(), unreachable)).toEqual(atRegister)
  })

  it('keeps this phone’s key and registration without a wallet', async () => {
    const ready = await walk('connect', 'create-key', 'register', 'ready')
    await disconnect()
    const forgotten = { step: 'connect', deviceKey: ready.deviceKey, device: ready.device }
    expect(await resolveIdentity(context())).toEqual(forgotten)
    await AsyncStorage.removeItem('device')
    expect(await resolveIdentity(context())).toEqual(forgotten)
    cluster.offline = true
    await AsyncStorage.removeItem('device')
    expect(await resolveIdentity(context())).toEqual({ step: 'connect', deviceKey: ready.deviceKey })
  })

  it('skips registration when this key is already bound to the wallet', async () => {
    await walk('connect', 'create-key', 'register')
    await cluster.bind((await getDeviceKey())!.publicKey, ALICE)
    expect((await resolveIdentity(context())).step).toBe('ready')
    expect(cluster.sent).toHaveLength(0)
  })

  it('reads the device account again before it sends a registration', async () => {
    const atRegister = await walk('connect', 'create-key', 'register')
    await cluster.bind((await getDeviceKey())!.publicKey, ALICE)
    expect(await advanceIdentity(context(), atRegister)).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(cluster.sent).toHaveLength(0)
  })

  it('shows a key bound to another wallet, and connects another wallet without registering', async () => {
    await walk('connect', 'create-key', 'register')
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

  it('records a registration before the wallet holds it, and confirms it after the app was killed', async () => {
    const atRegister = await walk('connect', 'create-key', 'register')
    cluster.landing = 'later'
    await killedWhileTheWalletHoldsIt(atRegister)
    const { publicKey } = (await getDeviceKey())!
    expect(JSON.parse(storedItems().registration)).toEqual({
      chain: CHAIN,
      key: bytesToHex(publicKey),
      wallet: ALICE,
      lastValidBlockHeight: '150',
    })
    // Fake timers never advance here: a wait would never end.
    const confirming = await resolveIdentity(context())
    expect(confirming).toEqual({ step: 'confirming', wallet: ALICE, deviceKey: atRegister.deviceKey })
    expect(await polled(advanceIdentity(context(), confirming))).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(storedItems()).not.toHaveProperty('registration')
    expect(cluster.sent).toHaveLength(1)
  })

  it('waits for a registration the wallet sent before it reported an error', async () => {
    const atRegister = await walk('connect', 'create-key', 'register')
    cluster.landing = 'later'
    walletFailure = 'after-sending'
    const sent = await polled(advanceIdentity(context(), atRegister))
    expect(sent).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(sent.error).toBeUndefined()
    expect(progress).toHaveBeenCalledExactlyOnceWith({
      step: 'confirming',
      wallet: ALICE,
      deviceKey: atRegister.deviceKey,
    })
    expect(storedItems()).not.toHaveProperty('registration')
    expect(cluster.sent).toHaveLength(1)
  })

  it('reports a declined registration at once, and another wallet error once it can no longer land', async () => {
    const atRegister = await walk('connect', 'create-key', 'register')
    walletFailure = 'declined'
    // Fake timers never advance here: a wait would never end.
    expect(await advanceIdentity(context(), atRegister)).toEqual({
      ...atRegister,
      error: 'You declined in your wallet. Nothing was sent and nothing was charged.',
      details: 'User declined',
    })
    expect(storedItems()).not.toHaveProperty('registration')
    walletFailure = 'before-sending'
    expect(await polled(advanceIdentity(context(), atRegister))).toEqual({
      ...atRegister,
      error: 'The registration didn’t go through. Nothing was charged and this phone is not registered. Try again.',
      details: 'The wallet closed the session.',
    })
    expect(storedItems()).not.toHaveProperty('registration')
    expect(cluster.sent).toHaveLength(0)
  })

  it('reports a sent registration that expired and offers it again', async () => {
    const atRegister = await walk('connect', 'create-key', 'register')
    cluster.landing = 'never'
    const expired = await polled(advanceIdentity(context(), atRegister))
    expect(expired).toEqual({ ...atRegister, error: EXPIRED })
    expect(storedItems()).not.toHaveProperty('registration')
    cluster.landing = 'now'
    expect((await advanceIdentity(context(), expired)).step).toBe('ready')
    expect(cluster.sent).toHaveLength(2)
  })

  it('reports at once a failure the cluster confirms for the signature the wallet returned', async () => {
    const atRegister = await walk('connect', 'create-key', 'register')
    cluster.landing = 'fails'
    const failed = await polled(advanceIdentity(context(), atRegister))
    expect(failed).toEqual({
      ...atRegister,
      error:
        'Solana didn’t accept this phone’s key signature. Your wallet paid the network fee; nothing else was charged and this phone is not registered.',
      details: '{"InstructionError":[2,{"Custom":6001}]}',
      signature: getBase58Decoder().decode(await cluster.processed[0]),
    })
    // Its blockhash is still valid: the wait ended at the first status read.
    expect(cluster.blockHeight).toBeLessThan(150n)
    expect(storedItems()).not.toHaveProperty('registration')
  })

  it('stops waiting by block height while the device account cannot be read, and keeps the record', async () => {
    const atRegister = await walk('connect', 'create-key', 'register')
    cluster.landing = 'never'
    await killedWhileTheWalletHoldsIt(atRegister)
    cluster.accountsUnavailable = true
    const confirming = await resolveIdentity(context())
    const unconfirmed = await polled(advanceIdentity(context(), confirming))
    expect(unconfirmed).toEqual({ ...confirming, error: UNCONFIRMED, details: 'Network request failed' })
    expect(storedItems()).toHaveProperty('registration')
    cluster.accountsUnavailable = false
    expect(await advanceIdentity(context(), unconfirmed)).toEqual({ ...atRegister, error: EXPIRED })
    expect(storedItems()).not.toHaveProperty('registration')
  })

  it('reads the device account at the slot of the block height it read, on an RPC whose nodes lag', async () => {
    const atRegister = await walk('connect', 'create-key', 'register')
    cluster.landing = 'later'
    // Account reads reach a lagging node until after the blockhash expired.
    cluster.lagging = 7
    walletFailure = 'after-sending'
    const unconfirmed = await polled(advanceIdentity(context(), atRegister))
    expect(unconfirmed).toMatchObject({ step: 'confirming', error: STALLED })
    expect(storedItems()).toHaveProperty('registration')
    walletFailure = 'none'
    expect(await polled(advanceIdentity(context(), unconfirmed))).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(cluster.sent).toHaveLength(1)
  })

  it('stops waiting after three minutes while the block height does not move, and keeps the record', async () => {
    const atRegister = await walk('connect', 'create-key', 'register')
    cluster.landing = 'never'
    await killedWhileTheWalletHoldsIt(atRegister)
    cluster.stalled = true
    const confirming = await resolveIdentity(context())
    const started = Date.now()
    const stalled = await polled(advanceIdentity(context(), confirming))
    expect(stalled).toEqual({ ...confirming, error: STALLED })
    expect(Date.now() - started).toBe(180_000)
    expect(storedItems()).toHaveProperty('registration')
    cluster.stalled = false
    expect(await polled(advanceIdentity(context(), stalled))).toEqual({ ...atRegister, error: EXPIRED })
    expect(storedItems()).not.toHaveProperty('registration')
  })

  it('drops a stored registration that is unreadable, of an older shape or of another chain', async () => {
    const atRegister = await walk('connect', 'create-key', 'register')
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
      await AsyncStorage.setItem('registration', stored)
      expect(await resolveIdentity(context())).toEqual(atRegister)
      expect(storedItems()).not.toHaveProperty('registration')
    }
  })

  it('creates and registers a key only for the cluster this build signs for', async () => {
    const atKey = await walk('connect', 'create-key')
    const mainnet = { ...context(), cluster: 'mainnet' as const }
    expect((await advanceIdentity(mainnet, atKey)).error).toBe(
      'This phone’s key is set up for devnet, and this app for mainnet. Nothing was created, sent or charged.',
    )
    expect(await getDeviceKey()).toBeNull()
    const atRegister = await advanceIdentity(context(), atKey)
    await AsyncStorage.setItem('device-key:cluster', 'mainnet')
    expect((await advanceIdentity(context(), atRegister)).error).toBe(
      'This phone’s key was created for mainnet, and this app signs for devnet. Nothing was sent or charged.',
    )
    expect(cluster.sent).toHaveLength(0)
  })

  it('limits a registration to the most expensive one at the bump of its key, and to at least 40,000 CU', () => {
    expect([255, 239, 238, 235, 0].map((bump) => registerDeviceComputeUnitLimit(bump))).toEqual([
      40_000, 40_000, 40_833, 45_333, 397_833,
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
    const atRegister = await walk('connect', 'create-key', 'register')
    walletFailure = 'revoked'
    const revoked = await advanceIdentity(context(), atRegister)
    expect(revoked).toMatchObject({ step: 'connect', error: expect.stringContaining('Connect it again') })
    expect(await cache.get()).toBeUndefined()
    expect(storedItems()).not.toHaveProperty('registration')
    walletFailure = 'none'
    await walk('connect', 'register', 'ready')
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
        describeIdentityError(refused(-3, 'declined'), 'register'),
        describeIdentityError(refused(-1, 'declined'), 'connect'),
        describeIdentityError(refused(-1, 'revoked'), 'register'),
        describeIdentityError(refused(-4, 'not submitted'), 'register'),
        describeIdentityError(missing, 'connect'),
        describeIdentityError(offline, 'register'),
        describeIdentityError(offline, 'confirming'),
        describeIdentityError(new Error('Keystore failed'), 'create-key'),
      ].map(({ error }) => error),
    ).toEqual([
      'You declined in your wallet. Nothing was sent and nothing was charged.',
      'The wallet declined the connection. Nothing was shared and nothing was charged.',
      'Your wallet no longer recognizes Buckspay. Nothing was sent and nothing was charged. Connect it again.',
      'Your wallet couldn’t send the registration. Nothing was charged and this phone is not registered. Try again.',
      'No wallet app on this phone works with Buckspay. Install Phantom or Solflare, then try again.',
      UNREACHABLE,
      UNCONFIRMED,
      'This phone couldn’t create its key. Nothing was charged. Try again.',
    ])
    expect(describeIdentityError(missing, 'connect').details).toBe(missing.message)
  })

  it('registers for free: the wallet only signs, and the gateway pays and sends', async () => {
    const sponsor = (gateway = new Gateway())
    cluster.balances.set(ALICE, 0n)
    const atRegister = await walk('connect', 'create-key', 'register')
    expect(atRegister.sponsorship).toBe('free')
    const ready = await advanceIdentity(context(), atRegister)
    expect(ready).toMatchObject({ step: 'ready', wallet: ALICE, device: { wallet: ALICE } })
    expect(walletCalls).toBe(1)
    expect(sponsor.submitted).toBe(1)
    const { staticAccounts } = getCompiledTransactionMessageDecoder().decode(cluster.sent[0].messageBytes)
    expect(staticAccounts.slice(0, 2)).toEqual([SPONSOR, ALICE])
    expect(progress).toHaveBeenCalledExactlyOnceWith({
      step: 'confirming',
      wallet: ALICE,
      deviceKey: ready.deviceKey,
      signature: expect.any(String),
    })
    expect(storedItems()).not.toHaveProperty('registration')
  })

  it.each([
    ['own-key', 'Buckspay’s server offered a registration this app didn’t ask for'],
    ['transfer', 'Buckspay’s server offered a registration this app didn’t ask for'],
    ['price', 'Buckspay’s server offered a registration this app didn’t ask for'],
    ['unparsable', 'Buckspay’s server offered a registration this app didn’t ask for'],
    ['refuses', 'Buckspay couldn’t pay for this registration.'],
    ['rejects', 'Buckspay couldn’t pay for this registration.'],
  ] as const)(
    'never shows the wallet a registration the gateway changed, and offers to pay instead (%s)',
    async (mode, error) => {
      const sponsor = (gateway = new Gateway())
      const atRegister = await walk('connect', 'create-key', 'register')
      sponsor.mode = mode
      const refused = await advanceIdentity(context(), atRegister)
      expect(refused).toMatchObject({ step: 'register', sponsorship: 'unavailable', quote: atRegister.quote })
      expect(refused.error).toContain(error)
      expect(refused.error).toContain(
        'Nothing was sent and nothing was charged. You can register now and pay from your wallet.',
      )
      // The wallet signs only what the app built: the gateway refused it after the wallet signed.
      expect(walletCalls).toBe(mode === 'refuses' || mode === 'rejects' ? 1 : 0)
      expect(sponsor.submitted).toBe(0)
      expect(cluster.sent).toHaveLength(0)
      expect(storedItems()).not.toHaveProperty('registration')
      // The next tap registers with the wallet paying, as the screen now says.
      expect(await advanceIdentity(context(), refused)).toMatchObject({ step: 'ready', wallet: ALICE })
      const { staticAccounts } = getCompiledTransactionMessageDecoder().decode(cluster.sent[0].messageBytes)
      expect(staticAccounts[0]).toBe(ALICE)
    },
  )

  it.each([
    ['can pay', 2_000_000_000n, 'You can register now and pay from your wallet.'],
    ['cannot pay', 0n, 'To register now, add SOL to your wallet and pay from it.'],
  ] as const)(
    'falls back when Buckspay’s registration would fail, and says whether the wallet %s instead',
    async (_, balance, instead) => {
      const sponsor = (gateway = new Gateway())
      cluster.balances.set(ALICE, balance)
      const atRegister = await walk('connect', 'create-key', 'register')
      // What simulating the gateway's transaction gives once its fee payer ran dry.
      cluster.simulationError = 'InsufficientFundsForFee'
      const refused = await advanceIdentity(context(), atRegister)
      expect(refused).toMatchObject({ step: 'register', sponsorship: 'unavailable', quote: atRegister.quote })
      expect(refused.error).toBe(
        `Buckspay couldn’t pay for this registration. Nothing was sent and nothing was charged. ${instead}`,
      )
      expect(walletCalls).toBe(0)
      expect(sponsor.submitted).toBe(0)
    },
  )

  it('waits for a registration the gateway may have sent when a proxy answers for it', async () => {
    const sponsor = (gateway = new Gateway())
    const atRegister = await walk('connect', 'create-key', 'register')
    sponsor.mode = 'lost'
    expect(await advanceIdentity(context(), atRegister)).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(sponsor.submitted).toBe(1)
    expect(cluster.sent).toHaveLength(1)
  })

  it('waits past its own RPC’s lifetime for a gateway whose RPC is ahead', async () => {
    const sponsor = (gateway = new Gateway())
    const atRegister = await walk('connect', 'create-key', 'register')
    // The registration lands only after the app's own blockhash (50 blocks, 20 a read) expired.
    sponsor.mode = 'lost'
    cluster.landing = 'later'
    cluster.laterReads = 5
    expect(await polled(advanceIdentity(context(), atRegister))).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(cluster.sent).toHaveLength(1)
  })

  it('waits for an unanswered submission only as long as its own RPC says it can land', async () => {
    const sponsor = (gateway = new Gateway())
    const atRegister = await walk('connect', 'create-key', 'register')
    sponsor.mode = 'silent'
    const expired = await polled(advanceIdentity(context(), atRegister))
    expect(expired).toMatchObject({ step: 'register', error: EXPIRED })
    expect(storedItems()).not.toHaveProperty('registration')
  })

  it('has the wallet pay when the gateway does not offer to', async () => {
    const sponsor = (gateway = new Gateway())
    sponsor.mode = 'unavailable'
    const atRegister = await walk('connect', 'create-key', 'register')
    expect(atRegister.sponsorship).toBe('unavailable')
    expect(await advanceIdentity(context(), atRegister)).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(sponsor.submitted).toBe(0)
    const { staticAccounts } = getCompiledTransactionMessageDecoder().decode(cluster.sent[0].messageBytes)
    expect(staticAccounts[0]).toBe(ALICE)
  })

  it.each([
    ['unsupported', 'Your wallet can’t sign a registration that Buckspay pays for.'],
    ['altered', 'Your wallet changed the registration before signing it, so it wasn’t sent.'],
  ] as const)('offers to pay from the wallet when it cannot sign for a sponsor (%s)', async (failure, error) => {
    const sponsor = (gateway = new Gateway())
    const atRegister = await walk('connect', 'create-key', 'register')
    walletFailure = failure
    const refused = await advanceIdentity(context(), atRegister)
    expect(refused).toMatchObject({ step: 'register', sponsorship: 'unavailable' })
    expect(refused.error).toContain(error)
    expect(sponsor.submitted).toBe(0)
    expect(storedItems()).not.toHaveProperty('registration')
    walletFailure = 'none'
    expect(await advanceIdentity(context(), refused)).toMatchObject({ step: 'ready', wallet: ALICE })
    expect(sponsor.submitted).toBe(0)
  })

  it('sends nothing when the wallet declines a sponsored registration, or is killed while it holds it', async () => {
    const sponsor = (gateway = new Gateway())
    const atRegister = await walk('connect', 'create-key', 'register')
    walletFailure = 'declined'
    expect(await advanceIdentity(context(), atRegister)).toEqual({
      ...atRegister,
      error: 'You declined in your wallet. Nothing was sent and nothing was charged.',
      details: 'User declined',
    })
    walletFailure = 'killed'
    void advanceIdentity(context(), atRegister)
    while (walletCalls < 2) await new Promise((resolve) => setImmediate(resolve))
    // The app was killed: a relaunch offers the free registration again, with nothing to wait for.
    expect(await resolveIdentity(context())).toEqual(atRegister)
    expect(sponsor.submitted).toBe(0)
    expect(storedItems()).not.toHaveProperty('registration')
  })

  it('clears an authorization the wallet forgot while it signs for a sponsor', async () => {
    gateway = new Gateway()
    const atRegister = await walk('connect', 'create-key', 'register')
    walletFailure = 'revoked'
    const revoked = await advanceIdentity(context(), atRegister)
    expect(revoked).toMatchObject({ step: 'connect', error: expect.stringContaining('Connect it again') })
    expect(await cache.get()).toBeUndefined()
    walletFailure = 'none'
    await walk('connect', 'register', 'ready')
  })
})
