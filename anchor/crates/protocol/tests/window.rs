use buckspay_protocol::{
    lock::EXPIRY_STEP,
    lock::{CLAIM_WINDOW, RECORD_TTL},
    window::{
        claim_closable_at, claims_end, closable_at, reclaim, reclaim_opens, report_deadline,
        settle, Reclaim, Settle,
    },
    CHALLENGE, GRACE,
};
use proptest::prelude::*;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(50_000))]

    /// Closing a record can never reopen its output: once the record may be closed neither a
    /// settlement (of the output or of a descendant, whose expiry is never later) nor a reclaim
    /// can be accepted.
    #[test]
    fn nothing_opens_once_the_record_is_closable(
        expiry in any::<u32>(), lock in any::<u32>(), now in any::<u32>(), shorter in any::<u32>(),
    ) {
        let descendant = expiry.min(shorter);
        if u64::from(now) >= closable_at(expiry, lock) {
            prop_assert_ne!(settle(descendant, lock, now), Settle::Open);
            prop_assert_ne!(reclaim(expiry, lock, now), Reclaim::Open);
        }
    }

    /// A record is never created already closable: whatever opens, opens before the close.
    #[test]
    fn what_opens_leaves_the_record_open(
        expiry in any::<u32>(), lock in any::<u32>(), now in any::<u32>(), shorter in any::<u32>(),
    ) {
        let descendant = expiry.min(shorter);
        if settle(descendant, lock, now) == Settle::Open || reclaim(expiry, lock, now) == Reclaim::Open {
            prop_assert!(u64::from(now) < closable_at(expiry, lock));
        }
    }

    /// Settlement and reclaim of one output are complementary: never both, and before the lock
    /// ends settlement is open exactly while reclaim is too early.
    #[test]
    fn settle_and_reclaim_partition_the_time_before_the_lock_ends(
        expiry in any::<u32>(), lock in any::<u32>(), now in any::<u32>(),
    ) {
        let settled = settle(expiry, lock, now);
        let reclaimed = reclaim(expiry, lock, now);
        prop_assert!(!(settled == Settle::Open && reclaimed == Reclaim::Open));
        if now < lock {
            prop_assert_eq!(settled == Settle::Open, reclaimed == Reclaim::TooEarly);
            prop_assert_eq!(
                settled == Settle::Closed,
                matches!(reclaimed, Reclaim::Open | Reclaim::Closed)
            );
        } else {
            prop_assert_eq!(settled, Settle::LockEnded);
            prop_assert_eq!(reclaimed, Reclaim::LockEnded);
        }
    }

    /// The record outlives every report and every claim window a report on the output can open.
    #[test]
    fn the_record_outlives_every_report_and_claim(expiry in any::<u32>(), lock in any::<u32>()) {
        prop_assert!(closable_at(expiry, lock) >= claims_end(expiry, lock));
        prop_assert!(closable_at(expiry, lock) >= report_deadline(expiry).min(u64::from(lock)));
    }

    /// An ancestor is never closable before its descendants, so its record is still there
    /// whenever a chain through it is presented.
    #[test]
    fn an_ancestor_outlives_its_descendants(
        parent in any::<u32>(), lock in any::<u32>(), shorter in any::<u32>(),
    ) {
        prop_assert!(closable_at(parent, lock) >= closable_at(parent.min(shorter), lock));
    }

    /// The retention depends on the output and the lock only: `RECORD_TTL` after the earlier of the
    /// settlement deadline and the lock end.
    #[test]
    fn the_retention_is_bounded(expiry in any::<u32>(), lock in any::<u32>()) {
        let first = (u64::from(expiry) + u64::from(GRACE)).min(u64::from(lock));
        prop_assert_eq!(closable_at(expiry, lock), first + u64::from(RECORD_TTL));
        prop_assert!(closable_at(expiry, lock) <= u64::from(lock) + u64::from(RECORD_TTL));
        prop_assert_eq!(u64::from(RECORD_TTL), u64::from(CHALLENGE) + u64::from(CLAIM_WINDOW));
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(50_000))]

    /// A claim can be filed until the earlier of the claim deadline of the contested output and
    /// the end of its lock; the record of the claim outlives that second, so a second claim of the
    /// same loss never finds the address free while a claim can still be filed.
    #[test]
    fn a_claim_outlives_every_second_it_can_be_filed(
        expiry in any::<u32>(), lock in any::<u32>(), now in any::<u32>(),
    ) {
        let fileable = now < lock && u64::from(now) <= report_deadline(expiry);
        if fileable {
            prop_assert!(u64::from(now) < claim_closable_at(expiry, lock));
        }
        if u64::from(now) >= claim_closable_at(expiry, lock) {
            prop_assert!(!fileable);
        }
    }

    /// The life of a claim, and so the float a sponsor holds for it, is a function of the contested
    /// output: at most `E + GRACE + CHALLENGE + CLAIM_WINDOW + RECORD_TTL` whatever the lock.
    #[test]
    fn a_claim_lives_by_its_output_and_never_by_its_lock(expiry in any::<u32>(), lock in any::<u32>()) {
        let bound = u64::from(expiry)
            + u64::from(GRACE)
            + u64::from(CHALLENGE)
            + u64::from(CLAIM_WINDOW)
            + u64::from(RECORD_TTL);
        prop_assert!(claim_closable_at(expiry, lock) <= bound);
        prop_assert!(claim_closable_at(expiry, u32::MAX) <= bound);
        prop_assert_eq!(
            claim_closable_at(expiry, lock),
            report_deadline(expiry).min(u64::from(lock)) + u64::from(CLAIM_WINDOW) + u64::from(RECORD_TTL)
        );
    }

    /// A payee's reclaim opens before the spender's reclaim of the output it paid with, by at least
    /// `EXPIRY_STEP`: whenever the spender's window is open the payee's has already opened.
    #[test]
    fn the_payee_reclaims_first(parent in EXPIRY_STEP..u32::MAX, gap in 0u32..4_000_000_000, lock in any::<u32>(), now in any::<u32>()) {
        let child = parent.saturating_sub(EXPIRY_STEP.saturating_add(gap));
        prop_assume!(u64::from(child) + u64::from(EXPIRY_STEP) <= u64::from(parent));
        prop_assert!(reclaim_opens(child) + u64::from(EXPIRY_STEP) <= reclaim_opens(parent));
        if reclaim(parent, lock, now) == Reclaim::Open {
            prop_assert_ne!(reclaim(child, lock, now), Reclaim::TooEarly);
        }
    }

    /// The seconds between the two openings belong to the payee alone: its reclaim is open, the
    /// spender's is too early, and the lock is the only thing that can end the head start.
    /// The clock is drawn inside the thin band the other properties rarely reach.
    #[test]
    fn the_head_start_is_the_payees(parent in 2_000_000u32..3_000_000_000, extra in 0..RECORD_TTL - EXPIRY_STEP, offset in any::<u32>(), lock_extra in 1u32..100_000_000) {
        let child = parent - EXPIRY_STEP - extra;
        let (from, to) = (reclaim_opens(child), reclaim_opens(parent));
        let now = (from + u64::from(offset) % (to - from)) as u32;
        let lock = now + lock_extra;
        prop_assume!(u64::from(now) < closable_at(child, lock));
        prop_assert_eq!(reclaim(child, lock, now), Reclaim::Open);
        prop_assert_eq!(reclaim(parent, lock, now), Reclaim::TooEarly);
        prop_assert_eq!(reclaim(child, lock, (from - 1) as u32), Reclaim::TooEarly);
        prop_assert_ne!(reclaim(parent, lock, (to) as u32), Reclaim::TooEarly);
    }
}
