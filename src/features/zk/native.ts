import Prover, {
  type ClaimProof,
  type ClaimState,
  type KeyFiles,
  type KeyState,
  type KeyStatus,
  type ProveProgress,
  type StoredProof,
} from '../../../modules/prover/src/ProverModule'
import type { ProvingMode } from './types'

export type { ClaimProof, ClaimState, KeyFiles, KeyState, KeyStatus, ProveProgress, StoredProof }

export interface ProverNative {
  keyStatus(vkSha256: string): Promise<KeyStatus>
  ensureKey(files: KeyFiles, unmeteredOnly: boolean): Promise<void>
  dropKey(vkSha256: string): Promise<void>
  enqueue(noteId: string, chain: Uint8Array, missing: number[], vkSha256: string, mode: ProvingMode): Promise<void>
  cancel(noteId: string): Promise<void>
  collect(noteId: string, vkSha256: string): Promise<StoredProof[]>
  acknowledge(noteId: string, vkSha256: string, indices: number[]): Promise<void>
}

/** What the reward claims need of the prover: the key calls and the claim entry. */
export type ClaimProverNative = Pick<ProverNative, 'keyStatus' | 'ensureKey'> & {
  enqueueClaim(claimId: string, request: Uint8Array, vkSha256: string): Promise<void>
  collectClaim(claimId: string, vkSha256: string): Promise<ClaimProof | null>
  claimState(claimId: string): Promise<ClaimState>
  forgetClaim(claimId: string): Promise<void>
}

/** The only file that binds the prover module. */
export const proverNative: ProverNative = Prover

export const claimProverNative: ClaimProverNative = Prover
