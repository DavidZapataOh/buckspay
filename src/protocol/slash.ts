import { checkU64, U64_MAX } from './codec'

/** What a claim burns, as a multiple of the loss it proves. */
export const PENALTY_MULTIPLE = 2n
/** The maximum-size payments a bond backs at once. */
export const EXPOSURE_SLOTS = 2n

/**
 * What a claim of `loss` burns out of a free bond of `free`: `PENALTY_MULTIPLE` times the loss,
 * never more than the bond holds. The twin of `slash::penalty`.
 */
export function penalty(loss: bigint, free: bigint): bigint {
  checkU64(loss)
  checkU64(free)
  const burn = loss * PENALTY_MULTIPLE
  return burn < free ? burn : free
}

/** The total of unsettled value a bond safely backs. */
export function exposure(bond: bigint): bigint {
  checkU64(bond)
  return bond / PENALTY_MULTIPLE
}

/** The largest payment a receiver accepts on the strength of a bond. */
export const paymentLimit = (bond: bigint): bigint => exposure(bond) / EXPOSURE_SLOTS

/** Whether a lock with `bond` backs a payment of `amount`. */
export function covers(bond: bigint, amount: bigint): boolean {
  checkU64(amount)
  return amount <= paymentLimit(bond)
}

/** The smallest bond that backs a payment of `amount`, or `undefined` when no u64 bond does. */
export function minBond(amount: bigint): bigint | undefined {
  checkU64(amount)
  const bond = amount * PENALTY_MULTIPLE * EXPOSURE_SLOTS
  return bond <= U64_MAX ? bond : undefined
}
