import { NativeModule, requireNativeModule } from 'expo'

/** Purposes signed by `sign`; `note` envelopes go through `signNote` and its guard. */
export type SignedPurpose = 'witness'

export type Cluster = 'devnet' | 'mainnet'

export type SecurityLevel = 'strongbox' | 'tee' | 'hardware' | 'software' | 'unknown'

export type KeyRecord = {
  /** X.509 SubjectPublicKeyInfo, 91 bytes. */
  publicKey: Uint8Array
  securityLevel: SecurityLevel
  /** DER certificates, leaf first; empty when the key was generated without attestation. */
  attestationChain: Uint8Array[]
}

declare class HardwareKeysModule extends NativeModule {
  isStrongBoxAvailable(): boolean
  /** Binds signatures to a cluster and program, once per process. */
  configure(cluster: Cluster, programId: Uint8Array): void
  /** Creates the key and its note guard for the configured cluster and program, or returns the existing key. */
  createKey(challenge: Uint8Array): Promise<KeyRecord>
  getKey(): Promise<KeyRecord | null>
  /** DER signature over `DOMAIN(note) ‖ slot ‖ content`; a slot is signed with one content only, for good. */
  signNote(slot: Uint8Array, content: Uint8Array): Promise<Uint8Array>
  /** DER signature over `DOMAIN(purpose) ‖ slot ‖ content`. */
  sign(purpose: SignedPurpose, slot: Uint8Array, content: Uint8Array): Promise<Uint8Array>
  /**
   * DER signature over this device key's consent to being bound to `wallet` (32 bytes), a message
   * the module builds from the key: `DOMAIN(device) ‖ wallet ‖ SHA-256(ver ‖ 0x50 ‖ wallet ‖ key)`.
   */
  signDeviceBinding(wallet: Uint8Array): Promise<Uint8Array>
  /** Deletes the key, its creation marker and its note guards; the next `createKey` is a new identity. */
  resetKey(): Promise<void>
}

export default requireNativeModule<HardwareKeysModule>('HardwareKeys')
