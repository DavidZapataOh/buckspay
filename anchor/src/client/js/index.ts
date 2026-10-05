import {
  type Address,
  getProgramDerivedAddress,
  type ProgramDerivedAddress,
  type ReadonlyUint8Array,
} from '@solana/kit'
import { BUCKSPAY_PROGRAM_ADDRESS } from './generated'

export * from './generated'

const seed = (text: string) => new TextEncoder().encode(text)
const DEVICE_SEED = seed('device')
const ROTATION_SEED = seed('rotation')
const LOCK_SEED = seed('lock')

function keySeeds(key: ReadonlyUint8Array) {
  if (key.length !== 33) throw new Error('device key must be 33 bytes')
  return [key.subarray(0, 1), key.subarray(1)]
}

/** The `Device` account of a 33-byte device key: seeds `['device', key[..1], key[1..]]`. */
export function findDevicePda(
  key: ReadonlyUint8Array,
  programAddress: Address = BUCKSPAY_PROGRAM_ADDRESS,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({ programAddress, seeds: [DEVICE_SEED, ...keySeeds(key)] })
}

/** The `Rotation` account of a device key: seeds `['rotation', key[..1], key[1..]]`. */
export function findRotationPda(
  key: ReadonlyUint8Array,
  programAddress: Address = BUCKSPAY_PROGRAM_ADDRESS,
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({ programAddress, seeds: [ROTATION_SEED, ...keySeeds(key)] })
}

/** The `Lock` account of a device key's `lockSeq`-th lock: seeds `['lock', key[..1], key[1..], lockSeq u32 LE]`. */
export function findLockPda(
  key: ReadonlyUint8Array,
  lockSeq: number,
  programAddress: Address = BUCKSPAY_PROGRAM_ADDRESS,
): Promise<ProgramDerivedAddress> {
  const seeds = keySeeds(key)
  if (!Number.isInteger(lockSeq) || lockSeq < 0 || lockSeq > 0xffffffff) {
    throw new Error('lock number must be a u32')
  }
  const number = new Uint8Array(4)
  new DataView(number.buffer).setUint32(0, lockSeq, true)
  return getProgramDerivedAddress({ programAddress, seeds: [LOCK_SEED, ...seeds, number] })
}

/**
 * The compute unit limit of the app's `[set compute unit limit, secp256r1 verification,
 * register_device]` for a key whose device account has the canonical bump `bump`: the most expensive
 * registration (onto a device account address someone prefunded: 11,276 CU at bump 255 and 1,500 CU
 * more for each lower bump) plus 4,500 CU of instructions the wallet adds, and at least 40,000 CU.
 */
export function registerDeviceComputeUnitLimit(bump: number): number {
  return Math.max(40_000, 11_276 + 1_500 * (255 - bump) + 4_500)
}
