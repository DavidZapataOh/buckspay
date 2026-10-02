// Test double for the native HardwareKeys module, which needs Android Keystore and cannot load in
// Vitest. It signs like Keystore: DER, S not normalised, X.509 public key.
import { p256 } from '@noble/curves/nist.js'
import { equalBytes } from '@noble/curves/utils.js'
import { concatBytes, hexToBytes } from '@noble/hashes/utils.js'
import type { Cluster, KeyRecord, SignedPurpose } from '../../../modules/hardware-keys/src/HardwareKeysModule'
import { deviceBindingEnvelope, DEVNET_GENESIS_HASH, domain, envelope, MAINNET_GENESIS_HASH } from '../../protocol'

const SECRET_KEY = hexToBytes('07'.repeat(32))
const SPKI_P256_PREFIX = hexToBytes('3059301306072a8648ce3d020106082a8648ce3d030107034200')
const GENESIS_HASH = { devnet: DEVNET_GENESIS_HASH, mainnet: MAINNET_GENESIS_HASH }

let config: { cluster: Cluster; programId: Uint8Array } | undefined
let created = false
let signatures: Uint8Array[] = []

const coded = (code: string) => Object.assign(new Error(code), { code })

export function resetHardwareKeys() {
  config = undefined
  created = false
  signatures = []
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
  configure(cluster: Cluster, programId: Uint8Array) {
    if (!config) config = { cluster, programId }
    else if (config.cluster !== cluster || !equalBytes(config.programId, programId))
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
  signNote(slot: Uint8Array, content: Uint8Array): Promise<Uint8Array> {
    return sign('note', slot, content)
  },
  async sign(purpose: SignedPurpose, slot: Uint8Array, content: Uint8Array): Promise<Uint8Array> {
    if (purpose !== 'witness') throw coded('ERR_INVALID_ENVELOPE')
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
