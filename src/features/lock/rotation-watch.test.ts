import { findRotationPda, getRotationEncoder } from '@project/anchor'
import { address, getBase64Decoder } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { resolveProfile } from '../../protocol'
import { readPendingRotation } from './rotation-watch'

const PROGRAM = address(resolveProfile({}).programId)
const NEW_WALLET = address('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')
const PAYER = address('2t2uAzmx5tbSdU2MRZ6XU3i6D9bCqPb7S5tQe6Z2uJ8y')
const key = Uint8Array.from([3, ...Array.from({ length: 32 }, (_, i) => 32 - i)])

async function rpcWith(rotation?: Uint8Array) {
  const [expected] = await findRotationPda(key, PROGRAM)
  return {
    getAccountInfo: (account: string) => ({
      send: async () => ({
        context: { slot: 1n },
        value:
          rotation && account === expected
            ? {
                data: [getBase64Decoder().decode(rotation), 'base64'],
                executable: false,
                lamports: 1n,
                owner: PROGRAM,
                space: BigInt(rotation.length),
              }
            : null,
      }),
    }),
  } as never
}

describe('rotation watch', () => {
  it('alerts on a rotation the user did not request', async () => {
    const data = Uint8Array.from(
      getRotationEncoder().encode({ wallet: NEW_WALLET, payer: PAYER, effectiveAt: 1_900_000_000, bump: 255 }),
    )
    const alert = await readPendingRotation(await rpcWith(data), PROGRAM, key)
    expect(alert).toEqual({
      address: (await findRotationPda(key, PROGRAM))[0],
      newWallet: NEW_WALLET,
      payer: PAYER,
      effectiveAt: 1_900_000_000,
    })
  })

  it('says nothing while no rotation is pending', async () => {
    expect(await readPendingRotation(await rpcWith(), PROGRAM, key)).toBeUndefined()
  })
})
