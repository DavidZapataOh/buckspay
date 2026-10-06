import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  BUCKSPAY_ERROR__DEVICE_BINDING,
  BUCKSPAY_ERROR__DEVICE_KEY,
  fetchMaybeDevice,
  fetchMaybeLock,
  findDevicePda,
  findLockPda,
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
  compileTransaction,
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
import { notSent } from '../lock/gateway'
import {
  prepareSponsored,
  signSponsored,
  simulateTransaction,
  SponsorshipError,
  submitSponsored,
} from '../lock/gateway-onboard'
import { onboardingCopy } from '../lock/lock-copy'
import { buildSelfPaid, sendSelfPaid } from '../lock/perform'
import type { Operation } from '../lock/operations'
import {
  type Activation,
  type ActivationContext,
  type ActivationInput,
  activationOperation,
  checkInput,
  isSponsored,
  readActivation,
  readQuote,
} from './activation'

/**
 * `loading` until the cached authorization, the key and the device account have been read;
 * `unreachable` when Solana could not be read; `activate` while this phone has no registration and
 * lock; `confirming` while an activation handed to the wallet may still land; `other-wallet` when
 * this key is bound to another wallet than the connected one.
 */
export type IdentityStep =
  'loading' | 'unreachable' | 'connect' | 'create-key' | 'activate' | 'confirming' | 'other-wallet' | 'ready'

/** The on-chain binding of this device key, at `confirmed`. */
export type DeviceRecord = { address: Address; wallet: Address; key: ReadonlyUint8Array }

/**
 * `free` while the build's gateway offers to pay for the activation, `unavailable` when it does
 * not and the wallet pays; absent in builds without a gateway.
 */
export type Sponsorship = 'free' | 'unavailable'

export type IdentityState = {
  step: IdentityStep
  /** The wallet the cached authorization selects. */
  wallet?: Address
  deviceKey?: DeviceKey
  device?: DeviceRecord
  /** `activate`: the funds, the sponsor's terms and what the wallet would pay itself. */
  activation?: Activation
  /** `activate`: whether the gateway pays the network costs instead. */
  sponsorship?: Sponsorship
  /** The activation the wallet sent: while `confirming`, or after it failed on Solana. */
  signature?: Signature
  /** What went wrong and whether anything was sent or charged, in plain words. */
  error?: string
  /** The error behind `error`. */
  details?: string
}

export type IdentityContext = ActivationContext & {
  /** The cluster this build signs for. */
  cluster: Cluster
  chain: SolanaClusterId
  cache: WalletAuthorizationCache
  rpc: ActivationContext['rpc'] & Rpc<GetAccountInfoApi & GetEpochInfoApi & GetSignatureStatusesApi>
  connect: () => Promise<unknown>
  disconnect: () => Promise<void>
  /** Receives `confirming` once the wallet holds an activation, before the wait for it. */
  onProgress?: (state: IdentityState) => void
}

const commitment = 'confirmed'
const POLL_MS = 1000
/** How long one derivation waits for a sent activation before it asks to check again. */
const SETTLE_MS = 180_000
const PENDING = 'activation'
const DEVICE = 'device'
const KEY_CLUSTER = 'device-key:cluster'

/** After the device key was deleted: forgets the cluster and the registration recorded for it, then derives the step again. */
export async function forgetIdentity(ctx: IdentityContext): Promise<IdentityState> {
  for (const item of [PENDING, DEVICE, KEY_CLUSTER]) await AsyncStorage.removeItem(item)
  return resolveIdentity(ctx)
}

const NOTHING_SENT = 'Nothing was sent and nothing was charged.'
const NOT_ACTIVATED = 'Nothing was charged and this phone is not activated.'
const EXPIRED = `The activation expired before it landed. ${NOT_ACTIVATED}`
const STALLED = 'Solana hasn’t confirmed the activation yet. It may still land; check again in a minute.'
const PAY_INSTEAD = 'You can activate now and pay the network costs from your wallet.'
const FEE_CHANGED = 'Buckspay’s terms changed while you were looking. Review them and try again. Nothing was sent.'
/** Why an activation Buckspay was to pay for falls back to the wallet paying. */
const SPONSOR_FALLBACK: Record<SponsorshipError['reason'], string> = {
  unavailable: 'Buckspay couldn’t pay for this activation.',
  mismatch: 'Buckspay’s server offered an activation this app didn’t ask for, so your wallet never saw it.',
  unsupported: 'Your wallet can’t sign an activation that Buckspay pays for.',
  altered: 'Your wallet changed the activation before signing it, so it wasn’t sent.',
  unsigned: 'Your wallet couldn’t sign the activation.',
}
/** The JSON-RPC error of a wallet that does not implement a method, here `sign_transactions`. */
const METHOD_NOT_FOUND = -32601
const FAILED: Partial<Record<IdentityStep, string>> = {
  connect: 'The wallet couldn’t connect. Nothing was shared and nothing was charged. Try again.',
  'create-key': 'This phone couldn’t create its key. Nothing was charged. Try again.',
  activate: `The activation didn’t go through. ${NOT_ACTIVATED} Try again.`,
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
 * An activation handed to the wallet, recorded before the wallet holds it, with the signature the
 * wallet returns once it sent it.
 */
type Pending = {
  chain: SolanaClusterId
  key: string
  wallet: Address
  lastValidBlockHeight: string
  signature?: Signature
}

/**
 * The activate step once Buckspay won't pay: why, and whether the wallet can pay instead. A wallet
 * that changed the transaction without enough SOL to pay itself has nothing to offer, and says so.
 */
function payFromWallet(current: IdentityState, reason: SponsorshipError['reason'], details?: string): IdentityState {
  const sol = current.activation?.sol
  const canPay = sol !== undefined && sol.balance >= sol.cost
  const error =
    reason === 'altered' && !canPay
      ? onboardingCopy.walletChangedTransaction
      : `${SPONSOR_FALLBACK[reason]} ${NOTHING_SENT} ${canPay ? PAY_INSTEAD : 'To activate now, add SOL to your wallet and pay from it.'}`
  return { ...current, sponsorship: 'unavailable', error, details }
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
    // While activating, the wallet rejected the cached authorization; while connecting, it declined.
    return step === 'activate'
      ? { error: `Your wallet no longer recognizes Buckspay. ${NOTHING_SENT} Connect it again.`, details }
      : { error: 'The wallet declined the connection. Nothing was shared and nothing was charged.', details }
  }
  if (isWalletError(error, ERROR_NOT_SUBMITTED)) {
    return { error: `Your wallet couldn’t send the activation. ${NOT_ACTIVATED} Try again.`, details }
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
    const unreachable = 'Can’t reach Solana to check the activation. It may still land; check again once you’re online.'
    return { error: isOffline(error) ? unreachable : STALLED, details }
  }
  if (isOffline(error)) {
    return { error: 'Can’t reach Solana. Check your connection and try again. Nothing was sent.', details }
  }
  return { error: FAILED[step] ?? 'Buckspay couldn’t check this phone. Nothing was sent. Try again.', details }
}

/** An activation's transaction error, in plain words. */
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
    return 'Your wallet doesn’t have enough SOL for the activation.'
  }
  if (failure === 'ComputationalBudgetExceeded') return 'The activation ran out of compute on Solana.'
  return 'Solana rejected the activation.'
}

/** A stored activation, or `undefined` for one that is unreadable or of another shape. */
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
      isAddress(stored.wallet)
    ) {
      return { address, wallet: stored.wallet, key: hexToBytes(key) }
    }
  } catch {
    // Unreadable: the chain decides, and the next read replaces it.
  }
  return undefined
}

async function storeDevice(chain: SolanaClusterId, { address, wallet, key }: DeviceRecord) {
  const stored = { chain, address, wallet, key: bytesToHex(Uint8Array.from(key)) }
  await AsyncStorage.setItem(DEVICE, JSON.stringify(stored))
}

/** The device account of `key` at `address`: the account holds the wallet, its seeds the key. */
async function fetchDevice(
  ctx: IdentityContext,
  address: Address,
  key: ReadonlyUint8Array,
  minContextSlot?: bigint,
): Promise<DeviceRecord | undefined> {
  const account = await fetchMaybeDevice(ctx.rpc, address, { commitment, minContextSlot })
  if (!account.exists) return undefined
  return { address, wallet: account.data.wallet, key }
}

/** The error of a transaction the cluster has confirmed as failed, if it has. */
async function transactionError(ctx: IdentityContext, signature: Signature): Promise<TransactionError | undefined> {
  const {
    value: [status],
  } = await ctx.rpc.getSignatureStatuses([signature]).send()
  if (!status?.err || status.confirmationStatus === 'processed') return undefined
  return status.err
}

/** Whether the key's first lock exists: the activation registers the key and locks funds in one transaction. */
async function lockExists(ctx: IdentityContext, key: ReadonlyUint8Array, minContextSlot: bigint) {
  const [lock] = await findLockPda(key, 0, ctx.programAddress)
  return (await fetchMaybeLock(ctx.rpc, lock, { commitment, minContextSlot })).exists
}

/**
 * Waits for an activation the wallet may have sent until its device account exists, the cluster
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
    const key = hexToBytes(pending.key)
    const landed = await Promise.all([fetchDevice(ctx, address, key, slot), lockExists(ctx, key, slot)]).catch(
      () => undefined,
    )
    if (landed?.[0] && landed[1]) return { slot }
    const failed = pending.signature && (await transactionError(ctx, pending.signature).catch(() => undefined))
    if (failed) return { slot, failed }
    if (blockHeight > BigInt(pending.lastValidBlockHeight)) return { slot }
    if (Date.now() >= deadline) throw new IdentityError(STALLED)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/**
 * Refuses to create or activate a device key for a cluster other than the build's. The app always
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
 * again. An activation handed to the wallet is `confirming` until `advanceIdentity` settles it.
 */
async function derive(ctx: IdentityContext, refresh = false): Promise<IdentityState> {
  const wallet = (await ctx.cache.get())?.selectedAccount.address
  const deviceKey = (await getDeviceKey()) ?? undefined
  if (!deviceKey) return wallet ? { step: 'create-key', wallet } : { step: 'connect' }
  // A key created before its cluster was recorded (the app was killed in between) is this build's.
  if (!(await AsyncStorage.getItem(KEY_CLUSTER))) await AsyncStorage.setItem(KEY_CLUSTER, ctx.cluster)
  const key = bytesToHex(deviceKey.publicKey)
  const [address] = await findDevicePda(deviceKey.publicKey, ctx.programAddress)
  const stored = refresh ? undefined : await readDevice(ctx.chain, key, address)
  if (stored) {
    await AsyncStorage.removeItem(PENDING)
    return bound(wallet, deviceKey, stored)
  }
  const pending = await readPending()
  if (pending && pending.chain === ctx.chain && pending.key === key && pending.wallet === wallet) {
    return { step: 'confirming', wallet, deviceKey, signature: pending.signature }
  }
  // Another chain's, key's or wallet's activation says nothing about this one: the device account decides.
  if (pending) await AsyncStorage.removeItem(PENDING)
  try {
    const device = await fetchDevice(ctx, address, deviceKey.publicKey)
    if (device) {
      await storeDevice(ctx.chain, device)
      return bound(wallet, deviceKey, device)
    }
    if (!wallet) return { step: 'connect', deviceKey }
    const quote = await readQuote(ctx.gateway)
    const activation = await readActivation(ctx, wallet, quote)
    const sponsorship = ctx.gateway ? (quote?.available ? 'free' : 'unavailable') : undefined
    return { step: 'activate', wallet, deviceKey, activation, sponsorship }
  } catch (error) {
    if (!isUnreachable(error)) throw error
    if (!wallet) return { step: 'connect', deviceKey }
    return { step: 'unreachable', wallet, deviceKey, ...describeIdentityError(error, 'unreachable') }
  }
}

/** Derives the onboarding step; never `loading`. */
export const resolveIdentity = (ctx: IdentityContext, { refresh = false }: { refresh?: boolean } = {}) =>
  derive(ctx, refresh)

/**
 * Waits for the activation recorded for this key and wallet and drops its record once the device
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
  const [address] = await findDevicePda(deviceKey.publicKey, ctx.programAddress)
  let device: DeviceRecord | undefined
  let failed: TransactionError | undefined
  try {
    const settled = await settle(ctx, address, pending)
    failed = settled.failed
    device = await fetchDevice(ctx, address, deviceKey.publicKey, settled.slot)
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
    error: `${describeTransactionError(failed)} No funds moved, and this phone is not activated.`,
    details: json(failed),
    signature: pending.signature,
  }
}

/**
 * Activates through the gateway when the terms are within what it quoted, or with the wallet
 * paying: checks the activation before the wallet sees it, records it before it can be sent, and
 * waits for it once it was sent, or may have been.
 */
async function activate(ctx: IdentityContext, shown: IdentityState, input?: ActivationInput): Promise<IdentityState> {
  await checkCluster(ctx)
  // The device account decides: an activation sent since the screen was derived may have landed.
  const current = await derive(ctx)
  if (current.step === 'confirming') return confirm(ctx, current)
  const { activation, wallet } = current
  if (current.step !== 'activate' || !activation || !wallet) return current
  // The screen offered Buckspay's payment: if it is gone, the wallet decides whether to pay instead.
  if (shown.sponsorship === 'free' && current.sponsorship !== 'free') return payFromWallet(current, 'unavailable')
  const terms = input ?? { amount: activation.defaultAmount, lockDays: activation.defaultLockDays }
  const { quote } = activation
  if (shown.activation?.quote?.fee !== quote?.fee || shown.activation?.quote?.minFunding !== quote?.minFunding) {
    return { ...current, error: FEE_CHANGED }
  }
  const sponsored = shown.sponsorship === 'free' && isSponsored(activation, 'free', terms)
  const invalid = checkInput(activation, terms, sponsored)
  if (invalid) return { ...current, error: invalid }
  const operation = await activationOperation(
    ctx,
    wallet,
    activation.funding,
    terms,
    sponsored ? (quote?.fee ?? 0n) : 0n,
  )
  if (sponsored) return activateSponsored(ctx, current, operation)
  const { balance, cost } = activation.sol
  if (balance < cost) {
    return {
      ...current,
      error: `Your wallet has ${formatSol(balance)} SOL and activating costs about ${formatSol(cost, 'up')} SOL in network costs. Add SOL to your wallet, then try again. Nothing was sent.`,
    }
  }
  const built = await buildSelfPaid(ctx, operation)
  const rejected = await simulateTransaction(ctx, compileTransaction(built.message))
  if (rejected)
    return { ...current, error: `${describeTransactionError(rejected)} ${NOTHING_SENT}`, details: json(rejected) }
  // Recorded before the wallet holds it, so a relaunch after the app is killed meanwhile waits for it
  // instead of offering a second one.
  const pending: Pending = {
    chain: ctx.chain,
    key: bytesToHex(operation.key),
    wallet,
    lastValidBlockHeight: built.lastValidBlockHeight.toString(),
  }
  await AsyncStorage.setItem(PENDING, JSON.stringify(pending))
  const confirming: IdentityState = { step: 'confirming', wallet, deviceKey: current.deviceKey }
  let signature: SignatureBytes
  try {
    signature = await sendSelfPaid(built)
  } catch (error) {
    if (isWalletError(error, SolanaMobileWalletAdapterProtocolErrorCode.ERROR_AUTHORIZATION_FAILED)) throw error
    if (isWalletError(error, SolanaMobileWalletAdapterProtocolErrorCode.ERROR_NOT_SIGNED)) {
      await AsyncStorage.removeItem(PENDING)
      return { ...current, ...describeIdentityError(error, 'activate') }
    }
    // Any other wallet error may come after it sent the transaction: wait until it can no longer land.
    ctx.onProgress?.(confirming)
    const settled = await confirm(ctx, confirming)
    return settled.step === 'activate' ? { ...settled, ...describeIdentityError(error, 'activate') } : settled
  }
  const sent = { ...pending, signature: getBase58Decoder().decode(signature) as Signature }
  await AsyncStorage.setItem(PENDING, JSON.stringify(sent))
  const waiting = { ...confirming, signature: sent.signature }
  ctx.onProgress?.(waiting)
  return confirm(ctx, waiting)
}

/**
 * The sponsored activation: built by the app and checked against the gateway's, simulated, signed
 * by the wallet without sending, then sent by the gateway. Until the gateway has it nothing can be
 * sent, so a wallet that declines or fails sent nothing; one that cannot sign for a sponsor, or the
 * gateway's refusal or mismatch, falls back to the wallet paying, which the screen then shows.
 */
async function activateSponsored(
  ctx: IdentityContext,
  current: IdentityState,
  operation: Operation,
): Promise<IdentityState> {
  const fallback = (reason: SponsorshipError['reason'], error: unknown) =>
    payFromWallet(current, reason, formatError(error))
  const wallet = operation.wallet
  let sponsored
  try {
    sponsored = await prepareSponsored(ctx, operation)
  } catch (error) {
    if (error instanceof SponsorshipError) return fallback(error.reason, error.cause ?? error)
    throw error
  }
  // A sponsored activation Solana would reject, such as one whose fee payer ran dry, is Buckspay's to fix.
  const rejected = await simulateTransaction(ctx, sponsored.transaction)
  if (rejected) return payFromWallet(current, 'unavailable', json(rejected))
  let signed
  try {
    signed = await signSponsored(ctx, wallet, sponsored)
  } catch (error) {
    if (error instanceof SponsorshipError) return fallback(error.reason, error.cause ?? error)
    if (isWalletError(error, SolanaMobileWalletAdapterProtocolErrorCode.ERROR_AUTHORIZATION_FAILED)) throw error
    if (isWalletError(error, METHOD_NOT_FOUND)) return fallback('unsupported', error)
    return { ...current, ...describeIdentityError(error, 'activate') }
  }
  // Recorded before the gateway holds it, so a relaunch after the app is killed meanwhile waits for it.
  const pending: Pending = {
    chain: ctx.chain,
    key: bytesToHex(operation.key),
    wallet,
    lastValidBlockHeight: sponsored.lastValidBlockHeight.toString(),
  }
  await AsyncStorage.setItem(PENDING, JSON.stringify(pending))
  const confirming: IdentityState = { step: 'confirming', wallet, deviceKey: current.deviceKey }
  let signature: string
  try {
    signature = await submitSponsored(ctx, operation, signed)
  } catch (error) {
    if (!notSent(error)) {
      // No answer, or not the gateway's own: it may have sent it. Wait until it can no longer land.
      ctx.onProgress?.(confirming)
      return confirm(ctx, confirming)
    }
    await AsyncStorage.removeItem(PENDING)
    return fallback('unavailable', error)
  }
  if (!isSignature(signature)) {
    ctx.onProgress?.(confirming)
    return confirm(ctx, confirming)
  }
  const sent = { ...pending, signature }
  await AsyncStorage.setItem(PENDING, JSON.stringify(sent))
  const waiting = { ...confirming, signature }
  ctx.onProgress?.(waiting)
  return confirm(ctx, waiting)
}

/** Performs the action of `state.step` and derives the next state; `input` is what the user chose to add. */
export async function advanceIdentity(
  ctx: IdentityContext,
  state: IdentityState,
  input?: ActivationInput,
): Promise<IdentityState> {
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
      case 'activate':
        return await activate(ctx, state, input)
      case 'confirming':
        return await confirm(ctx, state)
      case 'ready':
        return state
    }
    return await resolveIdentity(ctx)
  } catch (error) {
    if (
      state.step === 'activate' &&
      isWalletError(error, SolanaMobileWalletAdapterProtocolErrorCode.ERROR_AUTHORIZATION_FAILED)
    ) {
      // The wallet rejected our cached authorization and no fresh one was made in that session:
      // nothing was sent; start over from a fresh connection.
      await AsyncStorage.removeItem(PENDING)
      await ctx.disconnect()
      return { ...(await resolveIdentity(ctx)), ...describeIdentityError(error, 'activate') }
    }
    return { ...state, ...describeIdentityError(error, state.step) }
  }
}
