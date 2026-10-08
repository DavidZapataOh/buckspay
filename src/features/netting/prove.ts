import { concatBytes } from '@noble/hashes/utils.js'
import { type NettingStatement, publicInputs } from '../../protocol/netting'
import { GatewayError } from '../lock/gateway'
import type { KeyFiles, NettingProver } from '../zk/native'

/** The hash of the verifying key the program verifies nettings with. */
export const NETTING_VK_SHA256 = 'db8f4dfd45a238ef2aef1fc640f710603d59c510cf54881e167294cb3cbdc46a'

export const NETTING_PROOF_LEN = 256
const POLL_MS = 500

export type ProveDeps = { prover?: NettingProver; pollMs?: number }

const nativeProver = async (): Promise<NettingProver> => (await import('../zk/native')).nettingProverNative

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * Proves a netting in the prover process and returns the 256-byte proof. The witness holds every salt and debt of
 * the session: the job and its files are forgotten whatever the outcome.
 */
export async function proveNetting(
  sessionId: string,
  witness: Uint8Array,
  signal: AbortSignal,
  deps: ProveDeps = {},
): Promise<Uint8Array> {
  const prover = deps.prover ?? (await nativeProver())
  const pollMs = deps.pollMs ?? POLL_MS
  try {
    signal.throwIfAborted()
    await prover.enqueueNetting(sessionId, witness, NETTING_VK_SHA256)
    for (;;) {
      signal.throwIfAborted()
      const proof = await prover.collectNetting(sessionId, NETTING_VK_SHA256)
      if (proof) return proof
      const { state, reason } = await prover.nettingState(sessionId)
      if (state === 'failed' || state === 'cancelled') throw new Error(reason || state)
      if (state === 'succeeded') {
        const last = await prover.collectNetting(sessionId, NETTING_VK_SHA256)
        if (last) return last
        throw new Error('The prover finished without a proof.')
      }
      await sleep(pollMs, signal)
    }
  } finally {
    await prover.forgetNetting(sessionId)
  }
}

/** Whether `proof` verifies against the four public inputs of `statement` under the pinned key. */
export async function verifyNettingProof(
  statement: NettingStatement,
  proof: Uint8Array,
  deps: ProveDeps = {},
): Promise<boolean> {
  if (proof.length !== NETTING_PROOF_LEN) return false
  const prover = deps.prover ?? (await nativeProver())
  return prover.verifyNetting(proof, concatBytes(...publicInputs(statement)), NETTING_VK_SHA256)
}

/** The key files the gateway offers for nettings; an offer for any other verifying key is refused. */
export async function nettingKeyFiles(gatewayUrl: string, deps: { fetch?: typeof fetch } = {}): Promise<KeyFiles> {
  const response = await (deps.fetch ?? fetch)(`${gatewayUrl}/v1/nettings/key`)
  const offer = await response.json().catch(() => null)
  if (!response.ok) throw new GatewayError(response.status, response.statusText)
  if (offer?.vkSha256 !== NETTING_VK_SHA256)
    throw new Error('The gateway offers a key the program does not verify with.')
  return offer as KeyFiles
}
