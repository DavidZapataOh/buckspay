//! What a proven loss burns, as pure functions shared by the program, the gateway and the app.
//!
//! A claim proves a loss (a payment somebody accepted on the strength of a lock and that cannot be
//! settled) and burns [`PENALTY_MULTIPLE`] times its amount out of the lock's free bond, as much
//! as the bond holds. Nobody is paid out of a burn: a bond that paid claimants would pay whoever
//! holds the lock's key, who can make the claims up. A culprit that steals no more than the lock's
//! [`exposure`] therefore loses at least twice what it stole whatever claims anybody files.

/// What a claim burns, as a multiple of the loss it proves.
pub const PENALTY_MULTIPLE: u64 = 2;
/// The maximum-size payments a bond backs at once. It sets the largest payment a receiver accepts
/// and is enforced by the receiving wallet and the payer's guard, not by the program.
pub const EXPOSURE_SLOTS: u64 = 2;

const _: () = {
    assert!(PENALTY_MULTIPLE >= 1);
    assert!(EXPOSURE_SLOTS >= 1);
};

/// What a claim of `loss` burns out of a free bond of `free`: [`PENALTY_MULTIPLE`] times the loss,
/// never more than the bond holds.
pub fn penalty(loss: u64, free: u64) -> u64 {
    // `loss * PENALTY_MULTIPLE` fits in a `u128`, and the minimum with `free` fits in a `u64`.
    (u128::from(loss) * u128::from(PENALTY_MULTIPLE)).min(u128::from(free)) as u64
}

/// The total of unsettled value a bond safely backs: the most a culprit can steal from receivers
/// that relied on the lock before the burn is smaller than twice what it stole.
pub fn exposure(bond: u64) -> u64 {
    bond / PENALTY_MULTIPLE
}

/// The largest payment, or output a spender consumes, that a receiver accepts on the strength of
/// a bond: the exposure shared by the payments that can be in flight at once.
pub fn payment_limit(bond: u64) -> u64 {
    exposure(bond) / EXPOSURE_SLOTS
}

/// Whether a lock with `bond` backs a payment of `amount`.
pub fn covers(bond: u64, amount: u64) -> bool {
    amount <= payment_limit(bond)
}

/// The smallest bond that backs a payment of `amount`, or `None` when no `u64` bond does.
pub fn min_bond(amount: u64) -> Option<u64> {
    if payment_limit(u64::MAX) < amount {
        return None;
    }
    let (mut low, mut high) = (0, u64::MAX);
    while low < high {
        let middle = low + (high - low) / 2;
        if payment_limit(middle) >= amount {
            high = middle;
        } else {
            low = middle + 1;
        }
    }
    Some(low)
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use proptest::prelude::*;
    use std::vec::Vec;

    #[test]
    fn production_parameters() {
        assert_eq!((PENALTY_MULTIPLE, EXPOSURE_SLOTS), (2, 2));
    }

    #[test]
    fn a_hundred_dollar_bond_backs_fifty_in_all_and_twenty_five_per_payment() {
        let bond = 100_000_000;
        assert_eq!(exposure(bond), 50_000_000);
        assert_eq!(payment_limit(bond), 25_000_000);
        assert!(covers(bond, 25_000_000));
        assert!(!covers(bond, 25_000_001));
    }

    #[test]
    fn a_claim_burns_twice_its_loss_and_never_more_than_the_free_bond() {
        assert_eq!(penalty(20, 100), 40);
        assert_eq!(penalty(0, 100), 0);
        assert_eq!(penalty(60, 100), 100);
        assert_eq!(penalty(u64::MAX, u64::MAX), u64::MAX);
        assert_eq!(penalty(5, 0), 0);
        assert_eq!(penalty(u64::MAX, 7), 7);
    }

    #[test]
    fn the_smallest_covering_bond_is_four_times_the_payment() {
        assert_eq!(min_bond(0), Some(0));
        assert_eq!(min_bond(100), Some(400));
        assert_eq!(payment_limit(400), 100);
        assert_eq!(payment_limit(399), 99);
        assert_eq!(min_bond(25_000_000), Some(100_000_000));
        assert_eq!(min_bond(u64::MAX), None);
    }

    /// Claims of one unit each against a bond of 100 burn 2 each until the bond is gone: the
    /// stolen value that stays inside the exposure (50) is burned twice over, and the next one
    /// finds the last two units, then nothing.
    #[test]
    fn the_burn_runs_out_with_the_bond() {
        let mut free = 100u64;
        let mut burned = Vec::new();
        for _ in 0..52 {
            let burn = penalty(1, free);
            free -= burn;
            burned.push(burn);
        }
        assert_eq!(burned.iter().sum::<u64>(), 100);
        assert_eq!(burned[..50], [2; 50]);
        assert_eq!(burned[50..], [0, 0]);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(4096))]

        #[test]
        fn a_burn_is_at_most_the_free_bond_and_at_most_the_multiple_of_the_loss(
            loss in any::<u64>(), free in any::<u64>(),
        ) {
            let burn = penalty(loss, free);
            prop_assert!(burn <= free);
            prop_assert!(u128::from(burn) <= u128::from(loss) * u128::from(PENALTY_MULTIPLE));
            // Either everything the loss asks for is burned, or the whole bond.
            prop_assert!(
                u128::from(burn) == u128::from(loss) * u128::from(PENALTY_MULTIPLE) || burn == free
            );
        }

        #[test]
        fn a_larger_loss_or_a_larger_bond_never_burns_less(
            a in any::<u64>(), b in any::<u64>(), free in any::<u64>(), more in any::<u64>(),
        ) {
            prop_assert!(penalty(a.min(b), free) <= penalty(a.max(b), free));
            prop_assert!(penalty(a, free) <= penalty(a, free.saturating_add(more)));
        }

        /// The bond covers the liability: claims that add up to no more than the exposure, filed
        /// one by one in any order and any split against the bond they were sized for, burn
        /// exactly twice what they prove, so a culprit that stole that much loses at least as
        /// much again.
        #[test]
        fn claims_within_the_exposure_burn_exactly_twice_their_loss(
            bond in any::<u64>(),
            cuts in proptest::collection::vec(any::<u64>(), 1..24),
        ) {
            let mut left = exposure(bond);
            let mut free = bond;
            let (mut stolen, mut burned) = (0u128, 0u128);
            for cut in cuts {
                let loss = cut % (left.saturating_add(1));
                left -= loss;
                let burn = penalty(loss, free);
                free -= burn;
                stolen += u128::from(loss);
                burned += u128::from(burn);
            }
            prop_assert_eq!(burned, stolen * u128::from(PENALTY_MULTIPLE));
            prop_assert!(burned <= u128::from(bond));
        }

        /// Whatever is claimed, in whatever order, the bond is never burned more than once.
        #[test]
        fn claims_burn_at_most_the_bond_in_all(
            bond in any::<u64>(),
            losses in proptest::collection::vec(any::<u64>(), 0..32),
        ) {
            let mut free = bond;
            let mut burned = 0u128;
            for loss in losses {
                let burn = penalty(loss, free);
                free -= burn;
                burned += u128::from(burn);
            }
            prop_assert_eq!(burned + u128::from(free), u128::from(bond));
        }

        #[test]
        fn a_payment_limit_is_never_more_than_a_share_of_the_exposure(bond in any::<u64>()) {
            prop_assert!(payment_limit(bond) * EXPOSURE_SLOTS <= exposure(bond));
            prop_assert!(exposure(bond) * PENALTY_MULTIPLE <= bond);
        }

        #[test]
        fn min_bond_is_the_smallest_bond_that_covers(amount in any::<u64>()) {
            match min_bond(amount) {
                Some(bond) => {
                    prop_assert!(covers(bond, amount));
                    prop_assert!(bond == 0 || !covers(bond - 1, amount));
                }
                None => prop_assert!(!covers(u64::MAX, amount)),
            }
        }

        #[test]
        fn the_limit_is_monotone_in_the_bond(a in any::<u64>(), b in any::<u64>()) {
            prop_assert!(payment_limit(a.min(b)) <= payment_limit(a.max(b)));
        }
    }
}
