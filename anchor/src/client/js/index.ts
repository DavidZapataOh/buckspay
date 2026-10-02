import {
  type Address,
  getProgramDerivedAddress,
  type ProgramDerivedAddress,
  type ReadonlyUint8Array,
} from '@solana/kit'
import { BUCKSPAY_PROGRAM_ADDRESS } from './generated'

export * from './generated'

const DEVICE_SEED = new TextEncoder().encode('device')

/** The `Device` account of a 33-byte device key: seeds `['device', key[..1], key[1..]]`. */
export function findDevicePda(
  key: ReadonlyUint8Array,
  programAddress: Address = BUCKSPAY_PROGRAM_ADDRESS,
): Promise<ProgramDerivedAddress> {
  if (key.length !== 33) throw new Error('device key must be 33 bytes')
  return getProgramDerivedAddress({ programAddress, seeds: [DEVICE_SEED, key.subarray(0, 1), key.subarray(1)] })
}

/**
 * The compute unit limit of the app's `[set compute unit limit, secp256r1 verification,
 * register_device]` for a key whose device account has the canonical bump `bump`: the most expensive
 * registration (onto a device account address someone prefunded: 10,833 CU at bump 255 and 1,500 CU
 * more for each lower bump) plus 4,500 CU of instructions the wallet adds, and at least 40,000 CU.
 */
export function registerDeviceComputeUnitLimit(bump: number): number {
  return Math.max(40_000, 10_833 + 1_500 * (255 - bump) + 4_500)
}
