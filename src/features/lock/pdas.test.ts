import { findDevicePda, findLockPda, findRotationPda } from '@project/anchor'
import { address, getProgramDerivedAddress } from '@solana/kit'
import { describe, expect, it } from 'vitest'

const KEY = Uint8Array.from([2, ...new Uint8Array(32).fill(9)])
const SHORT = address('JA82vFUvNM3vvRbYbiU3xx748qEchaJ3Htr8FKFEMFKT')
const seed = (text: string) => new TextEncoder().encode(text)

describe('program derived addresses', () => {
  it('derives the lock and the rotation of a key from the seeds the program uses', async () => {
    const programAddress = address('zkJoXgVrQ8kvJGvnAYXGaF8KgT9pUKKExXF4zoF2eTM')
    const [lock] = await getProgramDerivedAddress({
      programAddress,
      seeds: [seed('lock'), KEY.subarray(0, 1), KEY.subarray(1), Uint8Array.of(7, 0, 0, 0)],
    })
    expect((await findLockPda(KEY, 7))[0]).toBe(lock)
    const [rotation] = await getProgramDerivedAddress({
      programAddress,
      seeds: [seed('rotation'), KEY.subarray(0, 1), KEY.subarray(1)],
    })
    expect((await findRotationPda(KEY))[0]).toBe(rotation)
  })

  it('follows the program of another profile', async () => {
    for (const find of [findDevicePda, findRotationPda]) {
      expect((await find(KEY, SHORT))[0]).not.toBe((await find(KEY))[0])
    }
    expect((await findLockPda(KEY, 0, SHORT))[0]).not.toBe((await findLockPda(KEY, 0))[0])
  })

  it('refuses a key of the wrong width and a lock number that does not fit', async () => {
    expect(() => findLockPda(KEY.subarray(1), 0)).toThrow('device key must be 33 bytes')
    expect(() => findLockPda(KEY, -1)).toThrow('lock number must be a u32')
    expect(() => findLockPda(KEY, 2 ** 32)).toThrow('lock number must be a u32')
  })
})
