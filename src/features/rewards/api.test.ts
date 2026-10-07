import { bytesToHex } from '@noble/hashes/utils.js'
import { address, generateKeyPair, getAddressFromPublicKey, isSignerRole, isWritableRole } from '@solana/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import vector from '../../../gateway/tests/fixtures/sweep_vector.json'
import { createGateway } from '../lock/gateway'
import { buildClaimRequest, type ProvedClaim } from './api'
import { buildSweep, signSweep, type SweepInput } from './sweep'

const input = (): SweepInput => ({
  gateway: address(vector.gateway),
  fresh: address(vector.fresh),
  destinationOwner: address(vector.owner),
  mint: address(vector.mint),
  feeAccount: address(vector.feeAccount),
  decimals: vector.decimals,
  amount: BigInt(vector.amount),
  fee: BigInt(vector.fee),
  computeUnitLimit: vector.computeUnitLimit,
  computeUnitPrice: BigInt(vector.computeUnitPrice),
  blockhash: { blockhash: address('11111111111111111111111111111111') as never, lastValidBlockHeight: 0n },
  createsAccount: true,
})

describe('sweep', () => {
  it('builds exactly the instructions the gateway accepts', async () => {
    const message = await buildSweep(input())
    expect(message.feePayer.address).toBe(vector.gateway)
    expect(
      message.instructions.map((ix) => ({
        program: ix.programAddress,
        accounts: (ix.accounts ?? []).map((account) => ({
          address: account.address,
          signer: isSignerRole(account.role),
          writable: isWritableRole(account.role),
        })),
        data: bytesToHex(ix.data as Uint8Array),
      })),
    ).toEqual(vector.instructions)
  })

  it('leaves the gateway signature empty and signs for the fresh address', async () => {
    const fresh = await generateKeyPair()
    const wire = Buffer.from(
      await signSweep(await buildSweep({ ...input(), fresh: await getAddressFromPublicKey(fresh.publicKey) }), fresh),
      'base64',
    )
    expect(wire[0]).toBe(2)
    expect(wire.subarray(1, 65).every((byte) => byte === 0)).toBe(true)
    expect(wire.subarray(65, 129).some((byte) => byte !== 0)).toBe(true)
  })

  it('builds without a token account creation', async () => {
    const message = await buildSweep({ ...input(), createsAccount: false })
    expect(message.instructions).toHaveLength(4)
  })
})

describe('claim request', () => {
  const root = new Uint8Array(32).fill(7)
  const older = new Uint8Array(32).fill(6)
  const claim = (over: Partial<ProvedClaim> = {}): ProvedClaim => ({
    epoch: 0,
    root,
    nullifierHash: new Uint8Array(32).fill(1),
    exp: 2,
    proof: new Uint8Array(128).fill(3),
    ...over,
  })
  const context = {
    latestRoots: new Map([[0, root]]),
    maxFee: 900_000,
    vkSha256: new Uint8Array(32).fill(5),
    recipient: vector.fresh,
  }

  it('proves against the latest root of the epoch and always sends the fixed max fee', () => {
    const request = buildClaimRequest([claim()], context)
    expect(request.claims[0].root).toBe(btoa(String.fromCharCode(...root)))
    expect(request.maxFee).toBe(900_000)
  })

  it('refuses a proof against an older root, an unknown epoch and a wrong number of leaves', () => {
    expect(() => buildClaimRequest([claim({ root: older })], context)).toThrow('latest root')
    expect(() => buildClaimRequest([claim({ epoch: 1 })], context)).toThrow('latest root')
    expect(() => buildClaimRequest([], context)).toThrow('one to four')
    expect(() => buildClaimRequest(Array(5).fill(claim()), context)).toThrow('one to four')
  })
})

describe('rewards gateway', () => {
  afterEach(() => vi.unstubAllGlobals())
  const gateway = createGateway('https://gateway.test')

  it('posts claims and sweeps and reads their status', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ status: 'submitted', jobKey: 'k' }),
    )
    vi.stubGlobal('fetch', fetch)
    const request = buildClaimRequest(
      [{ epoch: 0, root: new Uint8Array(32), nullifierHash: new Uint8Array(32), exp: 1, proof: new Uint8Array(128) }],
      {
        latestRoots: new Map([[0, new Uint8Array(32)]]),
        maxFee: 900_000,
        vkSha256: new Uint8Array(32),
        recipient: vector.fresh,
      },
    )
    await gateway.submitClaims(request)
    await gateway.submitSweep('AA==')
    await gateway.claimStatus('k')
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['https://gateway.test/v1/claims', 'POST', JSON.stringify(request)],
      ['https://gateway.test/v1/sweeps', 'POST', JSON.stringify({ transaction: 'AA==' })],
      ['https://gateway.test/v1/claims/k', 'GET', undefined],
    ])
  })
})
