import Prover, {
  type KeyFiles,
  type KeyState,
  type KeyStatus,
  type ProveProgress,
  type StoredProof,
} from '../../../modules/prover/src/ProverModule'
import type { ProvingMode } from './types'

export type { KeyFiles, KeyState, KeyStatus, ProveProgress, StoredProof }

export interface ProverNative {
  keyStatus(vkSha256: string): Promise<KeyStatus>
  ensureKey(files: KeyFiles, unmeteredOnly: boolean): Promise<void>
  dropKey(vkSha256: string): Promise<void>
  enqueue(noteId: string, chain: Uint8Array, missing: number[], vkSha256: string, mode: ProvingMode): Promise<void>
  cancel(noteId: string): Promise<void>
  collect(noteId: string, vkSha256: string): Promise<StoredProof[]>
  acknowledge(noteId: string, vkSha256: string, indices: number[]): Promise<void>
}

/** The only file that binds the prover module. */
export const proverNative: ProverNative = Prover
