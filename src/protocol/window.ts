import { CHALLENGE, GRACE } from './codec'

/** The time rules of one output as pure functions of its expiry, the lock's end and the clock. */
/** The last second (inclusive) at which a spend of an output that expires at `expiry` is settled. */
export const settleDeadline = (expiry: number, grace = GRACE) => expiry + grace

/** The first second at which the owner of an output that expires at `expiry` can reclaim it. */
export const reclaimOpens = (expiry: number, grace = GRACE) => settleDeadline(expiry, grace) + 1

/** The last second (inclusive) at which a conflict on the output is reported. */
export const reportDeadline = (expiry: number, grace = GRACE, challenge = CHALLENGE) =>
  settleDeadline(expiry, grace) + challenge

/**
 * The second at which the record of the output may be closed: `recordTtl` after the earlier of the
 * settlement deadline and the end of the lock.
 */
export const closableAt = (expiry: number, lockUntil: number, recordTtl: number, grace = GRACE) =>
  Math.min(settleDeadline(expiry, grace), lockUntil) + recordTtl

export type Settle = 'open' | 'lockEnded' | 'closed'
export type Reclaim = 'tooEarly' | 'open' | 'lockEnded' | 'closed'

/** Whether a spend of an output with this `expiry` can be settled now. */
export function settle(expiry: number, lockUntil: number, now: number, grace = GRACE): Settle {
  if (now >= lockUntil) return 'lockEnded'
  return now > settleDeadline(expiry, grace) ? 'closed' : 'open'
}

/** Whether the owner of an output with this `expiry` can reclaim it now. */
export function reclaim(expiry: number, lockUntil: number, now: number, recordTtl: number, grace = GRACE): Reclaim {
  if (now >= lockUntil) return 'lockEnded'
  if (now <= settleDeadline(expiry, grace)) return 'tooEarly'
  return now < closableAt(expiry, lockUntil, recordTtl, grace) ? 'open' : 'closed'
}
