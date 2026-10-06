import { exposure, type Liability } from '../../protocol'

export type { Liability }
export type Limits = {
  /** The most one payment may be worth, in minor units of its mint. */
  maxPayment: bigint
}

export type Candidate = { amount: bigint; liable: readonly Liability[] }

export type Snapshot = {
  /** Unsettled amount already accepted that names this lock. */
  exposure(liability: Liability): bigint
  /** An earlier message of the same signer, slot and a different content: provable fraud. */
  conflicts: boolean
}

export type Refusal = 'DoubleSpend' | 'OverLimit' | 'AboveMax'
export type Verdict = { accept: true } | { accept: false; reason: Refusal }

/** What one lock's bond lets a receiver accept, unsettled, in total. */
export const lockCapacity = exposure

/** The receiver's local acceptance rules, in one place: the rules of `verifyPayment` are the protocol's, these are the wallet's. */
export function admit(candidate: Candidate, snapshot: Snapshot, limits: Limits): Verdict {
  if (snapshot.conflicts) return { accept: false, reason: 'DoubleSpend' }
  if (candidate.amount > limits.maxPayment) return { accept: false, reason: 'AboveMax' }
  for (const liability of candidate.liable) {
    if (snapshot.exposure(liability) + candidate.amount > lockCapacity(liability.bond)) {
      return { accept: false, reason: 'OverLimit' }
    }
  }
  return { accept: true }
}
