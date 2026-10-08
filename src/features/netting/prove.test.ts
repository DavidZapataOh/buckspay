import { readFileSync } from 'node:fs'
import { hexToBytes } from '@noble/hashes/utils.js'
import { describe, expect, it, vi } from 'vitest'
import vectors from '../../../prover/netting/testdata/vectors.json'
import { decodeStatement, publicInputs } from '../../protocol/netting'
import { NETTING_VK_SHA256, nettingKeyFiles, proveNetting, verifyNettingProof } from './prove'

const statement = decodeStatement(hexToBytes(vectors.cases[1].statement))
const witness = hexToBytes(vectors.cases[1].witness)
const proof = new Uint8Array(256).fill(7)

function prover(over: Partial<Record<string, unknown>> = {}) {
  return {
    enqueueNetting: vi.fn(async () => {}),
    collectNetting: vi.fn(async () => proof),
    forgetNetting: vi.fn(async () => {}),
    nettingState: vi.fn(async () => ({ state: 'running', reason: '' })),
    verifyNetting: vi.fn(async () => true),
    ...over,
  }
}

describe('netting proofs on the phone', () => {
  it('queues the witness under the pinned key and returns the 256-byte proof', async () => {
    const p = prover({ collectNetting: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(proof) })
    const out = await proveNetting('s1', witness, new AbortController().signal, { prover: p, pollMs: 1 })
    expect(out).toEqual(proof)
    expect(p.enqueueNetting).toHaveBeenCalledWith('s1', witness, NETTING_VK_SHA256)
    expect(p.forgetNetting).toHaveBeenCalledWith('s1')
  })

  it('rejects with the job reason when the job failed, and forgets it', async () => {
    const p = prover({
      collectNetting: vi.fn(async () => null),
      nettingState: vi.fn(async () => ({ state: 'failed', reason: 'invalid' })),
    })
    await expect(proveNetting('s1', witness, new AbortController().signal, { prover: p, pollMs: 1 })).rejects.toThrow(
      'invalid',
    )
    expect(p.forgetNetting).toHaveBeenCalledWith('s1')
  })

  it('forgets the job when aborted', async () => {
    const p = prover({ collectNetting: vi.fn(async () => null) })
    const abort = new AbortController()
    const running = proveNetting('s1', witness, abort.signal, { prover: p, pollMs: 1 })
    abort.abort()
    await expect(running).rejects.toThrow()
    expect(p.forgetNetting).toHaveBeenCalledWith('s1')
  })

  it('verifies with the four public inputs of the statement and the pinned key', async () => {
    const p = prover()
    expect(await verifyNettingProof(statement, proof, { prover: p })).toBe(true)
    const [sent, publics, vk] = p.verifyNetting.mock.calls[0] as unknown as [Uint8Array, Uint8Array, string]
    expect(sent).toEqual(proof)
    expect(publics).toEqual(Uint8Array.from(publicInputs(statement).flatMap((x) => [...x])))
    expect(vk).toBe(NETTING_VK_SHA256)
    expect(await verifyNettingProof(statement, proof.slice(1), { prover: p })).toBe(false)
    expect(p.verifyNetting).toHaveBeenCalledTimes(1)
  })

  it('pins the key the program verifies with', () => {
    const rust = readFileSync('anchor/crates/zk-verify/src/vk/netting_test.rs', 'utf8')
    const bytes = [...rust.match(/VK_SHA256: \[u8; 32\] = \[([^\]]+)\]/)![1].matchAll(/0x([0-9a-f]{2})/g)].map(
      (m) => m[1],
    )
    expect(bytes.join('')).toBe(NETTING_VK_SHA256)
  })

  it('refuses a key offer for another verifying key', async () => {
    const offer = (vkSha256: string) => ({
      vkSha256,
      pkUrl: 'https://g/zk/x/pk.bin',
      pkSha256: 'a'.repeat(64),
      ccsUrl: 'https://g/zk/x/ccs.bin',
      ccsSha256: 'b'.repeat(64),
      dumpSha256: 'c'.repeat(64),
    })
    const fetch = vi.fn(async () => new Response(JSON.stringify(offer('d'.repeat(64))), { status: 200 }))
    await expect(nettingKeyFiles('https://g', { fetch })).rejects.toThrow()
    const good = vi.fn(async () => new Response(JSON.stringify(offer(NETTING_VK_SHA256)), { status: 200 }))
    expect((await nettingKeyFiles('https://g', { fetch: good })).vkSha256).toBe(NETTING_VK_SHA256)
  })
})
