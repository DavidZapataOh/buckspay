export type ProvingMode = 'charging' | 'deadline' | 'now'

/** A proof of one message: the compressed Groth16 proof (192 bytes) and its ten public inputs (320 bytes). */
export type ZkProof = { index: number; proof: Uint8Array; publicInputs: Uint8Array; vkSha256: string }

export type PrivateSettlementState =
  | { kind: 'needs-key'; progress: number }
  | { kind: 'waiting-for-charger'; proved: number; total: number }
  | { kind: 'proving'; proved: number; total: number }
  | { kind: 'ready' }
  | { kind: 'submitting' }
  | { kind: 'settled'; signature: string }
  | { kind: 'failed'; reason: 'stale-key' | 'invalid' | 'expired' | 'retry' }

/** The hashes that name a proving key, hex. */
export type KeyHashes = { vkSha256: string; pkSha256: string; ccsSha256: string; dumpSha256: string }

/** A key and where to fetch its files. */
export type KeyOffer = KeyHashes & { pkUrl: string; ccsUrl: string }

export const PROOF_BYTES = 192
export const PUBLIC_BYTES = 320
