import { describe, expect, it } from 'vitest'
import type { ZkChain } from './chain-wire'
import { answerToState, buildRequest } from './settle-private'

const chain = (n: number): ZkChain => ({
  issuerKey: new Uint8Array(33).fill(2),
  lockSeq: 7,
  amount: 5_000_000n,
  cumEnd: 9_000_000n,
  payAmount: 4_000_000n,
  expiry: 1_900_000_000,
  payee: new Uint8Array(32).fill(9),
  messages: Array.from({ length: n }, (_, i) => ({
    content: new Uint8Array(32).fill(i + 1),
    nextBit: (i % 2) as 0 | 1,
  })),
})

const proofs = (n: number, vk = 'ab'.repeat(32)) =>
  Array.from({ length: n }, (_, index) => ({
    index,
    vkSha256: vk,
    proof: new Uint8Array(192).fill(7),
    publicInputs: Uint8Array.from({ length: 320 }, (_, i) => (i >= 128 && i < 160 ? 0x40 + index : 0)),
  }))

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

describe('buildRequest', () => {
  it('sends the lock, the last payment and per message CONTENT, next bit, s_out and proof, base64 and decimal as the gateway reads them', () => {
    const request = buildRequest(chain(4), proofs(4), 'ab'.repeat(32))
    expect(request).toMatchObject({
      kind: 'zk',
      vkSha256: b64(new Uint8Array(32).fill(0xab)),
      lockKey: b64(new Uint8Array(33).fill(2)),
      lockSeq: 7,
      amount: '5000000',
      cumEnd: '9000000',
      payAmount: '4000000',
      expiry: 1_900_000_000,
      payee: b64(new Uint8Array(32).fill(9)),
    })
    expect(request.messages).toHaveLength(4)
    expect(request.messages[2]).toEqual({
      content: b64(new Uint8Array(32).fill(3)),
      nextBit: 0,
      sOut: b64(new Uint8Array(32).fill(0x42)),
      proof: b64(new Uint8Array(192).fill(7)),
    })
    expect(request.messages[1].nextBit).toBe(1)
  })

  it('has nothing else in it: no holder key, no body, no signature', () => {
    expect(Object.keys(buildRequest(chain(2), proofs(2), 'ab'.repeat(32))).sort()).toEqual(
      ['amount', 'cumEnd', 'expiry', 'kind', 'lockKey', 'lockSeq', 'messages', 'payAmount', 'payee', 'vkSha256'].sort(),
    )
  })

  it('refuses to build with a missing, stale or malformed proof', () => {
    expect(() => buildRequest(chain(2), [], 'ab'.repeat(32))).toThrow()
    expect(() => buildRequest(chain(2), proofs(1), 'ab'.repeat(32))).toThrow()
    expect(() => buildRequest(chain(2), proofs(2, 'cd'.repeat(32)), 'ab'.repeat(32))).toThrow()
    expect(() => buildRequest(chain(1), [{ ...proofs(1)[0], proof: new Uint8Array(196) }], 'ab'.repeat(32))).toThrow()
  })
})

describe('answerToState', () => {
  it('maps the gateway answers', () => {
    expect(answerToState({ status: 'settled', signature: 's' })).toEqual({ kind: 'settled', signature: 's' })
    expect(answerToState({ status: 'submitted' })).toEqual({ kind: 'submitting' })
    expect(answerToState({ status: 'duplicate' })).toEqual({ kind: 'submitting' })
    expect(answerToState({ status: 'refused', reason: 'stale_key' })).toEqual({ kind: 'failed', reason: 'stale-key' })
    expect(answerToState({ status: 'refused', reason: 'invalid' })).toEqual({ kind: 'failed', reason: 'invalid' })
    expect(answerToState({ status: 'refused', reason: 'window' })).toEqual({ kind: 'failed', reason: 'expired' })
    expect(answerToState({ status: 'refused', reason: 'conflict' })).toEqual({ kind: 'failed', reason: 'invalid' })
    expect(answerToState({ status: 'retry', retryAfter: 60 })).toEqual({ kind: 'failed', reason: 'retry' })
  })
})
