use buckspay::rules::*;
use proptest::prelude::*;

const RECORD_TTL: u64 = 1_209_600;

proptest! {
    #[test]
    fn a_ticket_that_matches_a_really_closed_lock_is_never_provably_false(
        lock_until in any::<u32>(), delay in 0u64..=100_000_000, later in 0u64..=100_000_000,
    ) {
        // close_lock succeeds only at or after lock_until + RECORD_TTL; any report comes at or after the close.
        let closed_at = u64::from(lock_until) + RECORD_TTL + delay;
        let reported_at = closed_at + later;
        prop_assert!(!closed_lock_ticket_is_false(lock_until, reported_at, RECORD_TTL));
    }

    #[test]
    fn a_ticket_still_useful_to_a_receiver_is_provably_false_over_a_closed_lock(
        now in 0u64..=u64::from(u32::MAX), ahead in 0u32..=31_622_400,
    ) {
        // A receiver accepts a ticket only if its lock_until is not in the past.
        let lock_until = u32::try_from(now + u64::from(ahead)).unwrap_or(u32::MAX);
        prop_assume!(u64::from(lock_until) >= now);
        prop_assert!(closed_lock_ticket_is_false(lock_until, now, RECORD_TTL));
    }

    #[test]
    fn the_fee_cap_never_panics_and_never_exceeds_a_quarter_or_a_whole_token(funds in any::<u64>(), decimals in any::<u8>()) {
        let cap = sponsor_fee_cap(funds, decimals);
        prop_assert!(cap <= funds / 4);
        prop_assert!(cap <= one_whole_token(decimals));
    }
}

#[test]
fn a_closed_lock_boundary_is_exact() {
    assert!(closed_lock_ticket_is_false(
        1_000,
        1_000 + RECORD_TTL - 1,
        RECORD_TTL
    ));
    assert!(!closed_lock_ticket_is_false(
        1_000,
        1_000 + RECORD_TTL,
        RECORD_TTL
    ));
}

#[test]
fn whole_token_is_exact_up_to_19_decimals_and_saturates_after() {
    assert_eq!(one_whole_token(0), 1);
    assert_eq!(one_whole_token(6), 1_000_000);
    assert_eq!(one_whole_token(19), 10_000_000_000_000_000_000);
    for decimals in [20, 38, 255] {
        assert_eq!(one_whole_token(decimals), u64::MAX, "{decimals} decimals");
    }
}

#[test]
fn an_attacker_mint_with_extreme_decimals_leaves_only_the_quarter_of_funds_cap() {
    assert_eq!(sponsor_fee_cap(400, 255), 100);
    assert_eq!(sponsor_fee_cap(u64::MAX, 20), u64::MAX / 4);
    assert_eq!(
        sponsor_fee_cap(100_000_000_000, 6),
        1_000_000,
        "the whole-token cap binds on a 6-decimal mint"
    );
}
