import { getBase64Decoder } from '@solana/kit'
import type { ZkChain } from './chain-wire'
import { PROOF_BYTES, type PrivateSettlementState, type ZkProof } from './types'

const base64 = (bytes: Uint8Array) => getBase64Decoder().decode(bytes)
const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16))
const S_OUT = 4

export type ZkSettlementRequest = {
  kind: 'zk'
  vkSha256: string
  lockKey: string
  lockSeq: number
  amount: string
  cumEnd: string
  payAmount: string
  expiry: number
  payee: string
  messages: { content: string; nextBit: number; sOut: string; proof: string }[]
}

export type ZkAnswer =
  | { status: 'submitted' | 'duplicate' }
  | { status: 'settled'; signature: string }
  | { status: 'retry'; retryAfter: number }
  | { status: 'refused'; reason: string }

/**
 * The request for the gateway: the issue's lock, the last payment, and for each message its content, which
 * output the next message consumes, the state it leaves and its proof. Holder keys and bodies are not in it.
 */
export function buildRequest(chain: ZkChain, proofs: ZkProof[], vkSha256: string): ZkSettlementRequest {
  const messages = chain.messages.map((message, index) => {
    const proof = proofs.find((candidate) => candidate.index === index && candidate.vkSha256 === vkSha256)
    if (!proof || proof.proof.length !== PROOF_BYTES) throw new Error(`Message ${index} has no proof under this key.`)
    return {
      content: base64(message.content),
      nextBit: message.nextBit,
      sOut: base64(proof.publicInputs.subarray(S_OUT * 32, (S_OUT + 1) * 32)),
      proof: base64(proof.proof),
    }
  })
  return {
    kind: 'zk',
    vkSha256: base64(hexBytes(vkSha256)),
    lockKey: base64(chain.issuerKey),
    lockSeq: chain.lockSeq,
    amount: chain.amount.toString(),
    cumEnd: chain.cumEnd.toString(),
    payAmount: chain.payAmount.toString(),
    expiry: chain.expiry,
    payee: base64(chain.payee),
    messages,
  }
}

/** What the gateway's answer means for the note. */
export function answerToState(answer: ZkAnswer): PrivateSettlementState {
  switch (answer.status) {
    case 'settled':
      return { kind: 'settled', signature: answer.signature }
    case 'submitted':
    case 'duplicate':
      return { kind: 'submitting' }
    case 'retry':
      return { kind: 'failed', reason: 'retry' }
    case 'refused':
      if (answer.reason === 'stale_key') return { kind: 'failed', reason: 'stale-key' }
      return { kind: 'failed', reason: answer.reason === 'window' ? 'expired' : 'invalid' }
  }
}
