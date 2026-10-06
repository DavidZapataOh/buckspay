import { getAttesterEncoder, getLedgerEncoder, findLedgerPda } from '@project/anchor'
import {
  address,
  type Address,
  getAddressDecoder,
  getBase64Decoder,
  getProgramDerivedAddress,
  getU16Encoder,
} from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { readRegistryEntry } from './registry-read'

const program = address('zkJoXgVrQ8kvJGvnAYXGaF8KgT9pUKKExXF4zoF2eTM')
const authority = address('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS')
const mint = address('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU')
const bytes = (n: number) => new Uint8Array(32).fill(n)
const base58 = getAddressDecoder()

const attesterAccount = getAttesterEncoder().encode({
  id: 1,
  authority,
  mint,
  key: bytes(3),
  prevKey: bytes(4),
  prevTrustedUntil: 77,
  prevUntil: 88,
  registeredAt: 1,
  status: 1,
  exitAt: 0,
  bump: 255,
})

async function chain(bondFree: bigint | undefined) {
  const [attester] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: [new TextEncoder().encode('attester'), getU16Encoder().encode(1)],
  })
  const [ledger] = await findLedgerPda({ lock: attester }, { programAddress: program })
  const data = new Map<Address, Uint8Array>([[attester, Uint8Array.from(attesterAccount)]])
  if (bondFree !== undefined) {
    data.set(
      ledger,
      Uint8Array.from(
        getLedgerEncoder().encode({
          backingLeft: 0n,
          bondFree,
          bondSlashed: 0n,
          payer: authority,
          key: new Uint8Array(33),
          lockSeq: 0,
          withdrawn: false,
          bump: 255,
        }),
      ),
    )
  }
  return {
    getAccountInfo: (account: Address) => ({
      send: async () => {
        const bytes = data.get(account)
        return {
          value: bytes && {
            data: [getBase64Decoder().decode(bytes), 'base64'],
            executable: false,
            lamports: 1n,
            owner: program,
            space: BigInt(bytes.length),
            rentEpoch: 0n,
          },
        }
      },
    }),
  }
}

describe('reading an attester from the registry', () => {
  it('returns its keys, status and the stake in its ledger as the program holds them', async () => {
    const read = await readRegistryEntry((await chain(1_000_000n)) as never, program, 1)
    expect(read).toMatchObject({
      key: bytes(3),
      prevKey: bytes(4),
      prevTrustedUntil: 77,
      status: 1,
      bondFree: 1_000_000n,
    })
    expect(base58.decode(read!.authority)).toBe(authority)
    expect(base58.decode(read!.mint)).toBe(mint)
  })

  it('is nothing when the attester or its ledger does not exist', async () => {
    expect(await readRegistryEntry((await chain(undefined)) as never, program, 1)).toBeUndefined()
    expect(await readRegistryEntry((await chain(5n)) as never, program, 2)).toBeUndefined()
  })
})
