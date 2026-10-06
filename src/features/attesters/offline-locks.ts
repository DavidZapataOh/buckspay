import { CHALLENGE, GRACE, type BondTicket } from '../../protocol'
import type { OfflineLock } from '../../payment/preflight'

/** A ticket is asked for again when it has less than this left, seconds. */
export const REFRESH_BEFORE = 12 * 3600

/**
 * The locks a payer can pay from: each active lock with its ticket, whose figures are the ones a
 * receiver checks, and where the lock's next issue starts.
 */
export function offlineLocks(
  tickets: ReadonlyMap<number, BondTicket>,
  active: readonly number[],
  cursors: ReadonlyMap<number, bigint>,
): OfflineLock[] {
  return active.flatMap((lockSeq) => {
    const ticket = tickets.get(lockSeq)
    if (!ticket) return []
    const { mint, bond, backing, lockUntil } = ticket
    return [{ lockSeq, mint, bond, backing, lockUntil, ticket, nextCumEnd: cursors.get(lockSeq) ?? 0n }]
  })
}

/** What the person can pay without internet: the backing left on every lock a receiver would still believe. */
export function allowance(locks: readonly OfflineLock[], now: number): bigint {
  return locks
    .filter(({ ticket, lockUntil }) => ticket.validUntil >= now && lockUntil > now + GRACE + CHALLENGE)
    .reduce((total, { backing, nextCumEnd }) => total + (backing > nextCumEnd ? backing - nextCumEnd : 0n), 0n)
}

/** Whether the tickets of the active locks should be asked for again: one is missing or about to run out. */
export function needsRefresh(active: readonly number[], locks: readonly OfflineLock[], now: number): boolean {
  if (active.length === 0) return false
  if (locks.length < active.length) return true
  return locks.some(({ ticket }) => ticket.validUntil - now < REFRESH_BEFORE)
}
