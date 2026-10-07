// Test double for the native HardwareKeys module, which needs Android Keystore and cannot load in
// Vitest. It signs like Keystore: DER, S not normalised, X.509 public key.
import { p256 } from '@noble/curves/nist.js'
import { equalBytes } from '@noble/curves/utils.js'
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import type { Cluster, KeyRecord, SignedPurpose } from '../../../modules/hardware-keys/src/HardwareKeysModule'
import {
  content,
  deviceBindingEnvelope,
  DEVNET_GENESIS_HASH,
  domain,
  envelope,
  MAINNET_GENESIS_HASH,
  reclaimBody,
} from '../../protocol'

const SECRET_KEY = hexToBytes('07'.repeat(32))
const SPKI_P256_PREFIX = hexToBytes('3059301306072a8648ce3d020106082a8648ce3d030107034200')
const GENESIS_HASH = { devnet: DEVNET_GENESIS_HASH, mainnet: MAINNET_GENESIS_HASH }

let config: { cluster: Cluster; programId: Uint8Array; grace: number } | undefined
let created = false
let signatures: Uint8Array[] = []
/** The expiry of every output the guard was told about, by output id. */
let outputs = new Map<string, number>()

const DAY = 24 * 60 * 60

const coded = (code: string) => Object.assign(new Error(code), { code })

export function resetHardwareKeys() {
  config = undefined
  created = false
  signatures = []
  outputs = new Map()
}

export const nativeSignatures = () => signatures
export const configuredProgramId = () => config?.programId

function signMessage(message: Uint8Array) {
  const der = p256.sign(message, SECRET_KEY, { prehash: true, lowS: false, format: 'der' })
  signatures.push(der)
  return der
}

async function sign(purpose: 'note' | SignedPurpose, slot: Uint8Array, content: Uint8Array) {
  if (!config) throw coded('ERR_NOT_CONFIGURED')
  if (!created) throw coded('ERR_KEY_NOT_FOUND')
  return signMessage(envelope(domain(purpose, GENESIS_HASH[config.cluster], config.programId), slot, content))
}

const record = (): KeyRecord => ({
  publicKey: concatBytes(SPKI_P256_PREFIX, p256.getPublicKey(SECRET_KEY, false)),
  securityLevel: 'software',
  attestationChain: [],
})

export default {
  isStrongBoxAvailable: () => false,
  configure(cluster: Cluster, programId: Uint8Array, grace: number) {
    if (!config) config = { cluster, programId, grace }
    else if (config.cluster !== cluster || !equalBytes(config.programId, programId) || config.grace !== grace)
      throw coded('ERR_ALREADY_CONFIGURED')
  },
  async createKey(): Promise<KeyRecord> {
    if (!config) throw coded('ERR_NOT_CONFIGURED')
    created = true
    return record()
  },
  async getKey(): Promise<KeyRecord | null> {
    return created ? record() : null
  },
  async resetKey(): Promise<void> {
    created = false
  },
  async recordOutput(output: Uint8Array, expiry: number): Promise<void> {
    if (output.length !== 32) throw coded('ERR_INVALID_ENVELOPE')
    outputs.set(bytesToHex(output), expiry)
  },
  /** Like the guard: only a recorded output, only once its settlement window is over, only a short deadline. */
  async signReclaim(output: Uint8Array, deadline: number): Promise<Uint8Array> {
    if (!config) throw coded('ERR_NOT_CONFIGURED')
    if (!created) throw coded('ERR_KEY_NOT_FOUND')
    const expiry = outputs.get(bytesToHex(output))
    if (expiry === undefined) throw coded('ERR_UNKNOWN_OUTPUT')
    const now = Math.floor(Date.now() / 1000)
    if (now <= expiry + config.grace) throw coded('ERR_RECLAIM_TOO_EARLY')
    if (deadline < now || deadline > now + DAY) throw coded('ERR_INVALID_DEADLINE')
    const reclaimDomain = domain('reclaim', GENESIS_HASH[config.cluster], config.programId)
    return signMessage(envelope(reclaimDomain, output, content(reclaimBody(deadline))))
  },
  signNote(slot: Uint8Array, content: Uint8Array): Promise<Uint8Array> {
    return sign('note', slot, content)
  },
  async sign(purpose: SignedPurpose, slot: Uint8Array, content: Uint8Array): Promise<Uint8Array> {
    if (purpose !== 'witness' && purpose !== 'payword') throw coded('ERR_INVALID_ENVELOPE')
    return sign(purpose, slot, content)
  },
  async signDeviceBinding(wallet: Uint8Array): Promise<Uint8Array> {
    if (!config) throw coded('ERR_NOT_CONFIGURED')
    if (wallet.length !== 32) throw coded('ERR_INVALID_ENVELOPE')
    if (!created) throw coded('ERR_KEY_NOT_FOUND')
    const deviceDomain = domain('device', GENESIS_HASH[config.cluster], config.programId)
    return signMessage(deviceBindingEnvelope(deviceDomain, wallet, p256.getPublicKey(SECRET_KEY, true)))
  },
}
