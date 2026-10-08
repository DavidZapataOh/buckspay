import { NativeModule, requireNativeModule } from 'expo'

export type KeyState = 'missing' | 'downloading' | 'expanding' | 'ready'
export type KeyStatus = { vkSha256: string; state: KeyState; progress: number; sizeBytes: number }
export type KeyFiles = {
  vkSha256: string
  pkUrl: string
  pkSha256: string
  ccsUrl: string
  ccsSha256: string
  dumpSha256: string
}
export type ProveProgress = {
  noteId: string
  done: number
  total: number
  /** WorkManager's state: `enqueued`, `running`, `succeeded`, `failed`, `blocked` or `cancelled`. */
  state: string
  reason: string
}
export type ClaimProof = { proof: Uint8Array; publicInputs: Uint8Array }
/** WorkManager's state of a claim (`unknown` when none was queued) and, when it failed, `no-key`, `no-request` or `invalid`. */
export type ClaimState = { state: string; reason: string }
export type StoredProof = { index: number; proof: Uint8Array; publicInputs: Uint8Array }

type ProverEvents = { onProgress: (progress: ProveProgress) => void }

/**
 * Proves the messages of a note in a separate process, as background work: `charging` waits for the charger,
 * `deadline` for nothing but a battery that is not low, `now` starts at once. Proofs are kept on disk as they
 * are made; `collect` returns them and `acknowledge` forgets those the app has stored.
 */
declare class ProverModule extends NativeModule<ProverEvents> {
  keyStatus(vkSha256: string): Promise<KeyStatus>
  ensureKey(files: KeyFiles, unmeteredOnly: boolean): Promise<void>
  dropKey(vkSha256: string): Promise<void>
  enqueue(noteId: string, chain: Uint8Array, missing: number[], vkSha256: string, mode: string): Promise<void>
  cancel(noteId: string): Promise<void>
  collect(noteId: string, vkSha256: string): Promise<StoredProof[]>
  /** Proves one blind claim in the prover process; the request holds the leaf secrets and is deleted once proved. */
  enqueueClaim(claimId: string, request: Uint8Array, vkSha256: string): Promise<void>
  collectClaim(claimId: string, vkSha256: string): Promise<ClaimProof | null>
  claimState(claimId: string): Promise<ClaimState>
  forgetClaim(claimId: string): Promise<void>
  /** Proves one netting in the prover process; the witness holds every salt and debt of the session and is deleted once proved. */
  enqueueNetting(sessionId: string, witness: Uint8Array, vkSha256: string): Promise<void>
  /** The 256-byte proof, or null while the job runs. */
  collectNetting(sessionId: string, vkSha256: string): Promise<Uint8Array | null>
  nettingState(sessionId: string): Promise<ClaimState>
  /** Deletes the witness and every proof of the session. */
  forgetNetting(sessionId: string): Promise<void>
  /** Verifies a netting proof against its four public inputs (128 bytes) under the key of `vkSha256`, in the prover process. */
  verifyNetting(proof: Uint8Array, publicInputs: Uint8Array, vkSha256: string): Promise<boolean>
  acknowledge(noteId: string, vkSha256: string, indices: number[]): Promise<void>
}

export type NettingProver = Pick<
  ProverModule,
  'enqueueNetting' | 'collectNetting' | 'nettingState' | 'forgetNetting' | 'verifyNetting'
>

export default requireNativeModule<ProverModule>('Prover')
