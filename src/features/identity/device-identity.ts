import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  BUCKSPAY_ERROR__DEVICE_BINDING,
  BUCKSPAY_ERROR__DEVICE_KEY,
  fetchMaybeDevice,
  findDevicePda,
} from '@project/anchor'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  SolanaMobileWalletAdapterError,
  SolanaMobileWalletAdapterErrorCode,
  SolanaMobileWalletAdapterProtocolError,
  SolanaMobileWalletAdapterProtocolErrorCode,
} from '@solana-mobile/mobile-wallet-adapter-protocol'
import {
  type Address,
  getBase58Decoder,
  type GetAccountInfoApi,
  type GetEpochInfoApi,
  type GetSignatureStatusesApi,
  isAddress,
  isSignature,
  isSolanaError,
  type ReadonlyUint8Array,
  type Rpc,
  type Signature,
  type SignatureBytes,
  type TransactionError,
} from '@solana/kit'
import type { SolanaClusterId, WalletAuthorizationCache } from '@wallet-ui/react-native-kit'
import { type Cluster, createDeviceKey, type DeviceKey, deviceKeyCluster, getDeviceKey } from '../../keys'
import { formatError } from '../../utils/format-error'
import { formatSol } from '../../utils/format-sol'
import {
  buildRegistration,
  quoteRegistration,
  type RegisterDeviceContext,
  type Registration,
  type RegistrationQuote,
  sendRegistration,
  simulateRegistration,
} from './register-device'

/**
 * `loading` until the cached authorization, the key and the device account have been read;
 * `unreachable` when Solana could not be read; `confirming` while a registration handed to the
 * wallet may still land; `other-wallet` when this key is bound to another wallet than the connected one.
 */
export type IdentityStep =
  'loading' | 'unreachable' | 'connect' | 'create-key' | 'register' | 'confirming' | 'other-wallet' | 'ready'

/** The on-chain binding of this device key, at `confirmed`. */
export type DeviceRecord = { address: Address; wallet: Address; key: ReadonlyUint8Array; registeredSlot: bigint }

export type IdentityState = {
  step: IdentityStep
  /** The wallet the cached authorization selects. */
  wallet?: Address
  deviceKey?: DeviceKey
  device?: DeviceRecord
  /** `register`: what registering costs and what the wallet holds. */
  quote?: RegistrationQuote
  /** The registration the wallet sent: while `confirming`, or after it failed on Solana. */
  signature?: Signature
  /** What went wrong and whether anything was sent or charged, in plain words. */
  error?: string
  /** The error behind `error`. */
  details?: string
}

export type IdentityContext = RegisterDeviceContext & {
  /** The cluster this build signs for. */
  cluster: Cluster
  chain: SolanaClusterId
  cache: WalletAuthorizationCache
  rpc: RegisterDeviceContext['rpc'] & Rpc<GetAccountInfoApi & GetEpochInfoApi & GetSignatureStatusesApi>
  connect: () => Promise<unknown>
  disconnect: () => Promise<void>
  /** Receives `confirming` once the wallet holds a registration, before the wait for it. */
  onProgress?: (state: IdentityState) => void
}

const commitment = 'confirmed'
const POLL_MS = 1000
/** How long one derivation waits for a sent registration before it asks to check again. */
const SETTLE_MS = 180_000
const PENDING = 'registration'
const DEVICE = 'device'
const KEY_CLUSTER = 'device-key:cluster'

const NOTHING_SENT = 'Nothing was sent and nothing was charged.'
const NOT_REGISTERED = 'Nothing was charged and this phone is not registered.'
const EXPIRED = `The registration expired before it landed. ${NOT_REGISTERED}`
const STALLED = 'Solana hasn’t confirmed the registration yet. It may still land; check again in a minute.'
const FAILED: Partial<Record<IdentityStep, string>> = {
  connect: 'The wallet couldn’t connect. Nothing was shared and nothing was charged. Try again.',
  'create-key': 'This phone couldn’t create its key. Nothing was charged. Try again.',
  register: `The registration didn’t go through. ${NOT_REGISTERED} Try again.`,
}

/** A failure these steps describe themselves. */
class IdentityError extends Error {
  details?: string
  constructor(message: string, details?: string) {
    super(message)
    this.details = details
  }
}

/**
 * A registration handed to the wallet, recorded before the wallet holds it, with the signature the
 * wallet returns once it sent it.
 */
type Pending = {
  chain: SolanaClusterId
  key: string
  wallet: Address
  lastValidBlockHeight: string
  signature?: Signature
}

const isWalletError = (error: unknown, code: number) =>
  error instanceof SolanaMobileWalletAdapterProtocolError && error.code === code

/** What `fetch` throws without a connection, or an RPC that answered with an error. */
const isOffline = (error: unknown) => error instanceof TypeError
const isUnreachable = (error: unknown) => isOffline(error) || isSolanaError(error)

const json = (value: unknown) => JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? Number(item) : item))

/** What went wrong at `step`, in words that say whether anything was sent or charged, and the raw error. */
export function describeIdentityError(error: unknown, step: IdentityStep): { error: string; details?: string } {
  if (error instanceof IdentityError) return { error: error.message, details: error.details }
  const { ERROR_AUTHORIZATION_FAILED, ERROR_NOT_SIGNED, ERROR_NOT_SUBMITTED } =
    SolanaMobileWalletAdapterProtocolErrorCode
  const details = formatError(error)
  if (isWalletError(error, ERROR_NOT_SIGNED)) {
    return { error: `You declined in your wallet. ${NOTHING_SENT}`, details }
  }
  if (isWalletError(error, ERROR_AUTHORIZATION_FAILED)) {
    // While registering, the wallet rejected the cached authorization; while connecting, it declined.
    return step === 'register'
      ? { error: `Your wallet no longer recognizes Buckspay. ${NOTHING_SENT} Connect it again.`, details }
      : { error: 'The wallet declined the connection. Nothing was shared and nothing was charged.', details }
  }
  if (isWalletError(error, ERROR_NOT_SUBMITTED)) {
    return { error: `Your wallet couldn’t send the registration. ${NOT_REGISTERED} Try again.`, details }
  }
  if (
    error instanceof SolanaMobileWalletAdapterError &&
    error.code === SolanaMobileWalletAdapterErrorCode.ERROR_WALLET_NOT_FOUND
  ) {
    return {
      error: 'No wallet app on this phone works with Buckspay. Install Phantom or Solflare, then try again.',
      details,
    }
  }
  if (step === 'confirming') {
    const unreachable =
      'Can’t reach Solana to check the registration. It may still land; check again once you’re online.'
    return { error: isOffline(error) ? unreachable : STALLED, details }
  }
  if (isOffline(error)) {
    return { error: 'Can’t reach Solana. Check your connection and try again. Nothing was sent.', details }
  }
  return { error: FAILED[step] ?? 'Buckspay couldn’t check this phone. Nothing was sent. Try again.', details }
}

/** A registration's transaction error, in plain words. */
function describeTransactionError(err: TransactionError): string {
  const failure = typeof err === 'object' && 'InstructionError' in err ? err.InstructionError[1] : err
  const custom = typeof failure === 'object' && 'Custom' in failure ? Number(failure.Custom) : undefined
  if (custom === BUCKSPAY_ERROR__DEVICE_KEY || custom === BUCKSPAY_ERROR__DEVICE_BINDING) {
    return 'Solana didn’t accept this phone’s key signature.'
  }
  // The system program's errors creating the device account: already in use, or not enough lamports.
  if (custom === 0) return 'This phone’s key is already registered on Solana.'
  if (
    custom === 1 ||
    failure === 'InsufficientFunds' ||
    failure === 'InsufficientFundsForFee' ||
    (typeof failure === 'object' && 'InsufficientFundsForRent' in failure)
  ) {
    return 'Your wallet doesn’t have enough SOL for the registration.'
  }
  if (failure === 'ComputationalBudgetExceeded') return 'The registration ran out of compute on Solana.'
  return 'Solana rejected the registration.'
}

/** A stored registration, or `undefined` for one that is unreadable or of another shape. */
function parsePending(stored: string): Pending | undefined {
  try {
    const { chain, key, wallet, lastValidBlockHeight, signature } = JSON.parse(stored) ?? {}
    if (
      typeof chain === 'string' &&
      typeof key === 'string' &&
      /^0[23][0-9a-f]{64}$/.test(key) &&
      typeof wallet === 'string' &&
      isAddress(wallet) &&
      typeof lastValidBlockHeight === 'string' &&
      /^\d+$/.test(lastValidBlockHeight) &&
      (signature === undefined || (typeof signature === 'string' && isSignature(signature)))
    ) {
      return { chain: chain as SolanaClusterId, key, wallet, lastValidBlockHeight, signature }
    }
  } catch {
    // Unreadable: dropped like any other record it cannot use.
  }
  return undefined
}

async function readPending(): Promise<Pending | undefined> {
  const stored = await AsyncStorage.getItem(PENDING)
  if (!stored) return undefined
  const pending = parsePending(stored)
  if (!pending) await AsyncStorage.removeItem(PENDING)
  return pending
}

/**
 * The device account stored once it was read at `confirmed`, if it is this key's on this chain. A
 * device account is never closed, so it stands in for the chain while Solana cannot be reached.
 */
async function readDevice(chain: SolanaClusterId, key: string, address: Address): Promise<DeviceRecord | undefined> {
  try {
    const stored = JSON.parse((await AsyncStorage.getItem(DEVICE)) ?? 'null') ?? {}
    if (
      stored.chain === chain &&
      stored.key === key &&
      stored.address === address &&
      typeof stored.wallet === 'string' &&
      isAddress(stored.wallet) &&
      typeof stored.registeredSlot === 'string' &&
      /^\d+$/.test(stored.registeredSlot)
    ) {
      return { address, wallet: stored.wallet, key: hexToBytes(key), registeredSlot: BigInt(stored.registeredSlot) }
    }
  } catch {
    // Unreadable: the chain decides, and the next read replaces it.
  }
  return undefined
}

async function storeDevice(chain: SolanaClusterId, { address, wallet, key, registeredSlot }: DeviceRecord) {
  const stored = { chain, address, wallet, key: bytesToHex(Uint8Array.from(key)), registeredSlot: `${registeredSlot}` }
  await AsyncStorage.setItem(DEVICE, JSON.stringify(stored))
}

async function fetchDevice(
  ctx: IdentityContext,
  address: Address,
  minContextSlot?: bigint,
): Promise<DeviceRecord | undefined> {
  const account = await fetchMaybeDevice(ctx.rpc, address, { commitment, minContextSlot })
  if (!account.exists) return undefined
  const { wallet, key, registeredSlot } = account.data
  return { address, wallet, key, registeredSlot }
}

/** The error of a transaction the cluster has confirmed as failed, if it has. */
async function transactionError(ctx: IdentityContext, signature: Signature): Promise<TransactionError | undefined> {
  const {
    value: [status],
  } = await ctx.rpc.getSignatureStatuses([signature]).send()
  if (!status?.err || status.confirmationStatus === 'processed') return undefined
  return status.err
}

/**
 * Waits for a registration the wallet may have sent until its device account exists, the cluster
 * reports its transaction failed, or its blockhash expired, and returns the slot to read the device
 * account at, with the error of a transaction that failed. The block height and the slot come from
 * one response and the account is read at that slot or later, so an account still missing once the
 * height passed `lastValidBlockHeight` never will exist, even on an RPC whose nodes lag each other.
 * An account or status that cannot be read does not stop that clock, and a cluster that stops
 * producing blocks ends the wait after `SETTLE_MS` with the record kept.
 */
async function settle(ctx: IdentityContext, address: Address, pending: Pending) {
  const deadline = Date.now() + SETTLE_MS
  for (;;) {
    const { absoluteSlot: slot, blockHeight } = await ctx.rpc.getEpochInfo({ commitment }).send()
    if (await fetchDevice(ctx, address, slot).catch(() => undefined)) return { slot }
    const failed = pending.signature && (await transactionError(ctx, pending.signature).catch(() => undefined))
    if (failed) return { slot, failed }
    if (blockHeight > BigInt(pending.lastValidBlockHeight)) return { slot }
    if (Date.now() >= deadline) throw new IdentityError(STALLED)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/**
 * Refuses to create or register a device key for a cluster other than the build's. The app always
 * configures the key for the build's cluster (`_layout.tsx`), so the first check only catches a
 * missing configuration; a key of another cluster shows in the cluster stored with it, as after an
 * update to a build for another cluster. Localnet and devnet builds both record `devnet`, the
 * cluster they both sign for.
 */
async function checkCluster(ctx: IdentityContext) {
  const configured = deviceKeyCluster()
  if (configured !== ctx.cluster) {
    throw new IdentityError(
      `This phone’s key is set up for ${configured ?? 'no network'}, and this app for ${ctx.cluster}. Nothing was created, sent or charged.`,
    )
  }
  const created = await AsyncStorage.getItem(KEY_CLUSTER)
  if (created && created !== ctx.cluster) {
    throw new IdentityError(
      `This phone’s key was created for ${created}, and this app signs for ${ctx.cluster}. Nothing was sent or charged.`,
    )
  }
}

/** The step of a device key whose device account exists. */
function bound(wallet: Address | undefined, deviceKey: DeviceKey, device: DeviceRecord): IdentityState {
  if (!wallet) return { step: 'connect', deviceKey, device }
  return { step: device.wallet === wallet ? 'ready' : 'other-wallet', wallet, deviceKey, device }
}

/**
 * Derives the step from its sources of truth: the cached wallet authorization, the Keystore key and
 * the device account, read from storage once it was seen on Solana unless `refresh` asks Solana
 * again. A registration handed to the wallet is `confirming` until `advanceIdentity` settles it.
 */
async function derive(
  ctx: IdentityContext,
  refresh = false,
): Promise<{ state: IdentityState; registration?: Registration }> {
  const wallet = (await ctx.cache.get())?.selectedAccount.address
  const deviceKey = (await getDeviceKey()) ?? undefined
  if (!deviceKey) return { state: wallet ? { step: 'create-key', wallet } : { step: 'connect' } }
  // A key created before its cluster was recorded (the app was killed in between) is this build's.
  if (!(await AsyncStorage.getItem(KEY_CLUSTER))) await AsyncStorage.setItem(KEY_CLUSTER, ctx.cluster)
  const key = bytesToHex(deviceKey.publicKey)
  const [address] = await findDevicePda(deviceKey.publicKey)
  const stored = refresh ? undefined : await readDevice(ctx.chain, key, address)
  if (stored) {
    await AsyncStorage.removeItem(PENDING)
    return { state: bound(wallet, deviceKey, stored) }
  }
  const pending = await readPending()
  if (pending && pending.chain === ctx.chain && pending.key === key && pending.wallet === wallet) {
    return { state: { step: 'confirming', wallet, deviceKey, signature: pending.signature } }
  }
  // Another chain's, key's or wallet's registration says nothing about this one: the device account decides.
  if (pending) await AsyncStorage.removeItem(PENDING)
  try {
    const device = await fetchDevice(ctx, address)
    if (device) {
      await storeDevice(ctx.chain, device)
      return { state: bound(wallet, deviceKey, device) }
    }
    if (!wallet) return { state: { step: 'connect', deviceKey } }
    const registration = await buildRegistration(wallet, ctx)
    const quote = await quoteRegistration(ctx, registration)
    return { state: { step: 'register', wallet, deviceKey, quote }, registration }
  } catch (error) {
    if (!isUnreachable(error)) throw error
    if (!wallet) return { state: { step: 'connect', deviceKey } }
    return { state: { step: 'unreachable', wallet, deviceKey, ...describeIdentityError(error, 'unreachable') } }
  }
}

/** Derives the onboarding step; never `loading`. */
export async function resolveIdentity(
  ctx: IdentityContext,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<IdentityState> {
  return (await derive(ctx, refresh)).state
}

/**
 * Waits for the registration recorded for this key and wallet and drops its record once the device
 * account has been read after it; an account that cannot be read keeps it for the next attempt.
 */
async function confirm(ctx: IdentityContext, state: IdentityState): Promise<IdentityState> {
  const { wallet, deviceKey } = state
  const pending = await readPending()
  if (
    !wallet ||
    !deviceKey ||
    !pending ||
    pending.chain !== ctx.chain ||
    pending.key !== bytesToHex(deviceKey.publicKey) ||
    pending.wallet !== wallet
  ) {
    return resolveIdentity(ctx)
  }
  const [address] = await findDevicePda(deviceKey.publicKey)
  let device: DeviceRecord | undefined
  let failed: TransactionError | undefined
  try {
    const settled = await settle(ctx, address, pending)
    failed = settled.failed
    device = await fetchDevice(ctx, address, settled.slot)
  } catch (error) {
    return { ...state, ...describeIdentityError(error, 'confirming') }
  }
  await AsyncStorage.removeItem(PENDING)
  if (device) {
    await storeDevice(ctx.chain, device)
    return bound(wallet, deviceKey, device)
  }
  const current = await resolveIdentity(ctx)
  if (!failed) return { ...current, error: EXPIRED }
  return {
    ...current,
    error: `${describeTransactionError(failed)} Your wallet paid the network fee; nothing else was charged and this phone is not registered.`,
    details: json(failed),
    signature: pending.signature,
  }
}

/**
 * Checks what the registration costs and simulates it before the wallet sees it, records it before
 * the wallet holds it, and waits for it once the wallet sent it, or may have.
 */
async function register(ctx: IdentityContext): Promise<IdentityState> {
  await checkCluster(ctx)
  // The device account decides: a registration sent since the screen was derived may have landed.
  const { state: current, registration } = await derive(ctx)
  if (current.step === 'confirming') return confirm(ctx, current)
  if (!registration || !current.quote) return current
  const { balance, cost } = current.quote
  if (balance < cost) {
    return {
      ...current,
      error: `Your wallet has ${formatSol(balance)} SOL and registering costs about ${formatSol(cost, 'up')} SOL. Add SOL to your wallet, then try again. Nothing was sent.`,
    }
  }
  const rejected = await simulateRegistration(ctx, registration)
  if (rejected)
    return { ...current, error: `${describeTransactionError(rejected)} ${NOTHING_SENT}`, details: json(rejected) }
  // Recorded before the wallet holds it, so a relaunch after the app is killed meanwhile waits for it
  // instead of offering a second one.
  const pending: Pending = {
    chain: ctx.chain,
    key: bytesToHex(registration.key),
    wallet: registration.wallet,
    lastValidBlockHeight: registration.lastValidBlockHeight.toString(),
  }
  await AsyncStorage.setItem(PENDING, JSON.stringify(pending))
  const confirming: IdentityState = { step: 'confirming', wallet: current.wallet, deviceKey: current.deviceKey }
  let signature: SignatureBytes
  try {
    signature = await sendRegistration(registration)
  } catch (error) {
    if (isWalletError(error, SolanaMobileWalletAdapterProtocolErrorCode.ERROR_AUTHORIZATION_FAILED)) throw error
    if (isWalletError(error, SolanaMobileWalletAdapterProtocolErrorCode.ERROR_NOT_SIGNED)) {
      await AsyncStorage.removeItem(PENDING)
      return { ...current, ...describeIdentityError(error, 'register') }
    }
    // Any other wallet error may come after it sent the transaction: wait until it can no longer land.
    ctx.onProgress?.(confirming)
    const settled = await confirm(ctx, confirming)
    return settled.step === 'register' ? { ...settled, ...describeIdentityError(error, 'register') } : settled
  }
  const sent = { ...pending, signature: getBase58Decoder().decode(signature) as Signature }
  await AsyncStorage.setItem(PENDING, JSON.stringify(sent))
  const waiting = { ...confirming, signature: sent.signature }
  ctx.onProgress?.(waiting)
  return confirm(ctx, waiting)
}

/** Performs the action of `state.step` and derives the next state. */
export async function advanceIdentity(ctx: IdentityContext, state: IdentityState): Promise<IdentityState> {
  try {
    switch (state.step) {
      case 'loading':
      case 'unreachable':
        break
      case 'connect':
      case 'other-wallet':
        try {
          if (state.wallet) await ctx.disconnect()
          await ctx.connect()
        } catch (error) {
          return { ...(await resolveIdentity(ctx)), ...describeIdentityError(error, 'connect') }
        }
        break
      case 'create-key':
        await checkCluster(ctx)
        await createDeviceKey()
        await AsyncStorage.setItem(KEY_CLUSTER, ctx.cluster)
        break
      case 'register':
        return await register(ctx)
      case 'confirming':
        return await confirm(ctx, state)
      case 'ready':
        return state
    }
    return await resolveIdentity(ctx)
  } catch (error) {
    if (
      state.step === 'register' &&
      isWalletError(error, SolanaMobileWalletAdapterProtocolErrorCode.ERROR_AUTHORIZATION_FAILED)
    ) {
      // The wallet rejected our cached authorization and no fresh one was made in that session:
      // nothing was sent; start over from a fresh connection.
      await AsyncStorage.removeItem(PENDING)
      await ctx.disconnect()
      return { ...(await resolveIdentity(ctx)), ...describeIdentityError(error, 'register') }
    }
    return { ...state, ...describeIdentityError(error, state.step) }
  }
}
