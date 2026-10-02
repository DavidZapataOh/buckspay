import { equalBytes } from '@noble/curves/utils.js'
import { BUCKSPAY_PROGRAM_ADDRESS } from '@project/anchor'
import { getAddressEncoder } from '@solana/kit'
import HardwareKeys, {
  type Cluster,
  type KeyRecord,
  type SecurityLevel,
  type SignedPurpose,
} from '../../modules/hardware-keys/src/HardwareKeysModule'
import {
  checkIssue,
  checkSpendStep,
  content,
  DEVNET_GENESIS_HASH,
  domain,
  encodeIssueBody,
  encodeSpendBody,
  envelope,
  interval,
  type Issue,
  issueSlot,
  MAINNET_GENESIS_HASH,
  type Output,
  ProtocolError,
  Purpose,
  type Spend,
  verifySignature,
} from '../protocol'
import { compactLowS, sec1FromSpki } from './convert'

export type DeviceKey = {
  /** SEC1 compressed, 33 bytes. */
  publicKey: Uint8Array
  securityLevel: SecurityLevel
  /** DER certificates, leaf first; recorded, never trusted. */
  attestationChain: Uint8Array[]
}

const GENESIS_HASH = { devnet: DEVNET_GENESIS_HASH, mainnet: MAINNET_GENESIS_HASH }
const PROGRAM_ID = Uint8Array.from(getAddressEncoder().encode(BUCKSPAY_PROGRAM_ADDRESS))

let genesisHash: Uint8Array | undefined
let publicKey: Uint8Array | undefined

function deviceKey(record: KeyRecord): DeviceKey {
  publicKey = sec1FromSpki(record.publicKey)
  return { publicKey, securityLevel: record.securityLevel, attestationChain: record.attestationChain }
}

/** Binds every signature to `cluster` and the program built into the app, once per process. */
export function configureDeviceKey(cluster: Cluster) {
  HardwareKeys.configure(cluster, PROGRAM_ID)
  genesisHash = GENESIS_HASH[cluster]
}

/** Creates the device key if it does not exist; never replaces an existing one. */
export async function createDeviceKey(): Promise<DeviceKey> {
  return deviceKey(await HardwareKeys.createKey(crypto.getRandomValues(new Uint8Array(32))))
}

export async function getDeviceKey(): Promise<DeviceKey | null> {
  const record = await HardwareKeys.getKey()
  return record && deviceKey(record)
}

/**
 * Deletes the device key; the next `createDeviceKey` is a new identity. Notes the old key received
 * and did not settle are lost with it. Internal to `src/keys` until the confirmed reset flow uses it.
 */
export async function resetDeviceIdentity(): Promise<void> {
  try {
    await HardwareKeys.resetKey()
  } finally {
    publicKey = undefined
  }
}

async function ownKey(): Promise<Uint8Array> {
  const key = publicKey ?? (await getDeviceKey())?.publicKey
  if (!key) throw new ProtocolError('Signer')
  return key
}

/** Returns the native signature over `DOMAIN(purpose) ‖ slot ‖ body` as compact low-S, once it verifies. */
async function verified(
  purpose: typeof Purpose.Note | SignedPurpose,
  slot: Uint8Array,
  body: Uint8Array,
  sign: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  if (!genesisHash) throw new Error('configureDeviceKey must be called before signing')
  const key = await ownKey()
  const message = envelope(domain(purpose, genesisHash, PROGRAM_ID), slot, body)
  const signature = compactLowS(await sign())
  verifySignature(key, message, signature)
  return signature
}

/** Signs an issue by this device, in the slot of the interval it claims on its lock. */
export async function signIssue(issue: Issue): Promise<Uint8Array> {
  checkIssue(issue)
  if (!equalBytes(issue.issuer, await ownKey())) throw new ProtocolError('Signer')
  const [start, end] = interval(issue)
  const slot = issueSlot(issue.lockSeq, start, end)
  const body = content(encodeIssueBody(issue))
  return verified(Purpose.Note, slot, body, () => HardwareKeys.signNote(slot, body))
}

/**
 * Signs a spend of `input`, an output this device owns, in the slot of its output id, once the
 * spend passes the protocol's checks for this hop at the current time.
 */
export async function signSpend(input: Output, spend: Spend): Promise<Uint8Array> {
  if (input.owner.type !== 'device' || !equalBytes(input.owner.key, await ownKey())) throw new ProtocolError('Owner')
  checkSpendStep(input, spend, Math.floor(Date.now() / 1000))
  const body = content(encodeSpendBody(spend))
  return verified(Purpose.Note, input.id, body, () => HardwareKeys.signNote(input.id, body))
}

const signed = (purpose: SignedPurpose) => (slot: Uint8Array, digest: Uint8Array) =>
  verified(purpose, slot, digest, () => HardwareKeys.sign(purpose, slot, digest))

// Its message is not defined yet: internal to `src/keys` until it is.
export const signWitness = signed(Purpose.Witness)
