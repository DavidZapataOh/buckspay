use buckspay_gateway::float::*;
use buckspay_protocol::{GRACE, lock::RECORD_TTL, window::closable_at};

mod float_support;
use float_support::*;

const RENT: u64 = 1_061_720;
const NOW: u32 = 1_900_000_000;
const SLOT: u64 = 1_000;
const USDC: u64 = 1_000_000;

#[test]
fn the_float_cap_counts_records_not_settlements() {
    let mut c = caps();
    c.float_cap = 5 * RENT;
    c.per_lock_max_percent = 100;
    c.steps.clear();
    let limits = SettlementLimits::new(c);
    let three = limits.reserve(settle(1, 1, 0, 3)).unwrap();
    assert_eq!(
        limits.reserve(settle(2, 2, 10, 3)).unwrap_err(),
        Refusal::FloatCap
    );
    let two = limits.reserve(settle(3, 3, 20, 2)).unwrap();
    assert_eq!(
        limits.reserve(settle(4, 4, 30, 1)).unwrap_err(),
        Refusal::FloatCap
    );
    begin(three, 1_000 * USDC).landed(SLOT).unwrap();
    drop(two);
    // The dropped reservation freed two records; the three that landed stay open.
    assert!(limits.reserve(settle(5, 5, 40, 2)).is_ok());
    assert_eq!(limits.open_records(), 3);
}

#[test]
fn a_reclaim_counts_like_a_settlement_and_has_the_same_minimum() {
    let mut c = caps();
    c.float_cap = 2 * RENT;
    c.per_lock_max_percent = 100;
    c.steps.clear();
    let limits = SettlementLimits::new(c);
    let dust = request(
        Kind::Reclaim,
        1,
        1,
        100 * USDC,
        1,
        records(0, 1, NOW + 31 * DAY),
        NOW,
    );
    assert_eq!(
        limits.reserve(dust).unwrap_err(),
        Refusal::BelowMinimum(50_000)
    );
    let reclaim = |key: u8, first: u64| {
        request(
            Kind::Reclaim,
            key,
            key,
            100 * USDC,
            USDC,
            records(first, 1, NOW + 31 * DAY),
            NOW,
        )
    };
    land(&limits, reclaim(1, 0));
    land(&limits, reclaim(2, 1));
    assert_eq!(
        limits.reserve(settle(3, 3, 2, 1)).unwrap_err(),
        Refusal::FloatCap
    );
    assert_eq!(
        limits.reserve(reclaim(4, 3)).unwrap_err(),
        Refusal::FloatCap
    );
}

#[test]
fn a_record_waits_for_its_horizon_whatever_the_life_of_the_lock() {
    let limits = SettlementLimits::new(caps());
    let lock_366 = NOW + 366 * DAY;
    // A note that expires in 10 days on a lock of 366 days is kept 10 + 7 + 14 days.
    let honest = closable_at(NOW + 10 * DAY, lock_366) as u32;
    assert_eq!(honest, NOW + 10 * DAY + GRACE + RECORD_TTL);
    let ok = request(
        Kind::Settlement,
        1,
        1,
        100 * USDC,
        USDC,
        records(0, 1, honest),
        NOW,
    );
    limits.reserve(ok).unwrap();
    // The same lock with a note that expires in 360 days: a year of float.
    let hostile = closable_at(NOW + 360 * DAY, lock_366) as u32;
    assert!(hostile - NOW > 366 * DAY);
    let long = request(
        Kind::Settlement,
        2,
        1,
        100 * USDC,
        USDC,
        records(1, 1, hostile),
        NOW,
    );
    let Refusal::Horizon { retry_at } = limits.reserve(long.clone()).unwrap_err() else {
        panic!("expected the horizon");
    };
    assert_eq!(retry_at, hostile - 45 * DAY);
    // From that second on it fits (the note is then 14 days from the end of its settlement window).
    let later = Request {
        now: retry_at,
        ..long
    };
    assert!(limits.reserve(later).is_ok());
    // The horizon never undercuts the retention of a record that is closable at once.
    const { assert!(45 * DAY >= RECORD_TTL) };
}

/// The latest record decides, not the first: an ancestor that lives longer than the output is
/// exactly what a long note hides behind a short one.
#[test]
fn the_horizon_looks_at_the_latest_record_not_the_earliest() {
    let limits = SettlementLimits::new(caps());
    let early = NOW + 31 * DAY;
    let late = NOW + 400 * DAY;
    let mixed = vec![
        NewRecord {
            address: address(0),
            closable_at: early,
        },
        NewRecord {
            address: address(1),
            closable_at: late,
        },
    ];
    for order in [mixed.clone(), mixed.into_iter().rev().collect()] {
        let r = request(Kind::Settlement, 1, 1, 100 * USDC, 2 * USDC, order, NOW);
        assert_eq!(
            limits.reserve(r).unwrap_err(),
            Refusal::Horizon {
                retry_at: late - 45 * DAY
            }
        );
    }
}

#[test]
fn a_lock_without_bond_holds_nothing_and_the_share_follows_the_bond_above_the_minimum() {
    let limits = SettlementLimits::new(caps());
    // With free records for every lock, 94 locks without bond would fill the cap.
    for bond in [0, USDC, 9 * USDC + 999_999] {
        assert_eq!(limits.lock_share(bond, RENT), 0);
        let r = request(
            Kind::Settlement,
            1,
            1,
            bond,
            USDC,
            records(0, 1, NOW + 31 * DAY),
            NOW,
        );
        assert_eq!(
            limits.reserve(r).unwrap_err(),
            Refusal::LockShare { allowed: 0 }
        );
    }
    assert_eq!(limits.lock_share(10 * USDC, RENT), 10);
    assert_eq!(limits.lock_share(100 * USDC, RENT), 100);
    // The largest bond cannot take more than a quarter of the cap: 942 records at this rent.
    assert_eq!(limits.lock_share(u64::MAX, RENT), 235);
}

/// A lock holds exactly its share: the last record that fits is accepted and the next is not.
#[test]
fn a_lock_holds_exactly_its_share_and_free_keys_and_networks_do_not_help() {
    let limits = SettlementLimits::new(caps());
    for i in 0..10u8 {
        let r = request(
            Kind::Settlement,
            i,
            7,
            10 * USDC,
            USDC,
            records(u64::from(i), 1, NOW + 31 * DAY),
            NOW,
        );
        land(&limits, r);
    }
    assert_eq!(limits.open_of_lock(&[7; 32]), 10);
    let eleventh = request(
        Kind::Settlement,
        99,
        7,
        10 * USDC,
        USDC,
        records(99, 1, NOW + 31 * DAY),
        NOW,
    );
    assert_eq!(
        limits.reserve(eleventh).unwrap_err(),
        Refusal::LockShare { allowed: 10 }
    );
    // Another lock is unaffected.
    assert!(
        limits
            .reserve(request(
                Kind::Settlement,
                98,
                8,
                10 * USDC,
                USDC,
                records(98, 1, NOW + 31 * DAY),
                NOW
            ))
            .is_ok()
    );
}

#[test]
fn a_holder_key_is_a_speed_bump_only() {
    let limits = SettlementLimits::new(caps());
    for i in 0..20u64 {
        let r = request(
            Kind::Settlement,
            1,
            1,
            10_000 * USDC,
            USDC,
            records(i, 1, NOW + 31 * DAY),
            NOW,
        );
        land(&limits, r);
        limits.closed(&[address(i)]).unwrap();
    }
    let again = request(
        Kind::Settlement,
        1,
        1,
        10_000 * USDC,
        USDC,
        records(50, 1, NOW + 31 * DAY),
        NOW,
    );
    assert_eq!(limits.reserve(again).unwrap_err(), Refusal::KeySpentToday);
    // A fresh key on the same lock and network passes: only the lock and the network bound it.
    let fresh = Request {
        key: [2; 33],
        ..request(
            Kind::Settlement,
            1,
            1,
            10_000 * USDC,
            USDC,
            records(51, 1, NOW + 31 * DAY),
            NOW,
        )
    };
    assert!(limits.reserve(fresh).is_ok());
}

#[test]
fn the_minimum_amount_climbs_with_the_pressure_and_falls_when_records_close() {
    let mut c = caps();
    c.float_cap = 100 * RENT;
    c.per_lock_max_percent = 100;
    c.per_key_per_day = 1_000;
    c.per_key_per_30_days = 1_000;
    c.per_lock_per_day = 1_000;
    c.per_prefix_per_day = 1_000;
    c.per_prefix_per_30_days = 1_000;
    let limits = SettlementLimits::new(c);
    assert_eq!(limits.status(NOW).min_amount, 50_000);
    let fill = |n: u64, first: u64| {
        let r = request(
            Kind::Settlement,
            1,
            1,
            10_000 * USDC,
            n * 100 * USDC,
            records(first, n, NOW + 31 * DAY),
            NOW,
        );
        land(&limits, r);
    };
    fill(50, 0);
    assert_eq!(limits.status(NOW).pressure_percent, 50);
    assert_eq!(limits.status(NOW).min_amount, 250_000);
    fill(15, 50);
    assert_eq!(limits.status(NOW).min_amount, 1_000_000);
    fill(15, 65);
    assert_eq!(limits.status(NOW).min_amount, 5_000_000);
    fill(10, 80);
    assert_eq!(limits.status(NOW).min_amount, 25_000_000);
    let small = request(
        Kind::Settlement,
        2,
        2,
        10_000 * USDC,
        5 * USDC,
        records(500, 1, NOW + 31 * DAY),
        NOW,
    );
    assert_eq!(
        limits.reserve(small).unwrap_err(),
        Refusal::BelowMinimum(25_000_000)
    );
    let all: Vec<[u8; 32]> = (0..90).map(address).collect();
    limits.closed(&all).unwrap();
    assert_eq!(limits.status(NOW).min_amount, 50_000);
}

/// An amount that is exactly the minimum is sponsored; one base unit less is not.
#[test]
fn an_amount_equal_to_the_minimum_is_sponsored() {
    let limits = SettlementLimits::new(caps());
    let at = |amount: u64| {
        request(
            Kind::Settlement,
            1,
            1,
            100 * USDC,
            amount,
            records(0, 1, NOW + 31 * DAY),
            NOW,
        )
    };
    assert_eq!(
        limits.reserve(at(49_999)).unwrap_err(),
        Refusal::BelowMinimum(50_000)
    );
    assert!(limits.reserve(at(50_000)).is_ok());
}

/// The minimum is asked for every record, not once per request: a chain of seven spends paid seven records
/// for one. The minimum is asked for every record the request creates.
#[test]
fn the_minimum_amount_is_asked_for_every_new_record() {
    let limits = SettlementLimits::new(caps());
    let seven = |amount: u64| {
        request(
            Kind::Settlement,
            1,
            1,
            100 * USDC,
            amount,
            records(0, 7, NOW + 31 * DAY),
            NOW,
        )
    };
    assert_eq!(
        limits.reserve(seven(349_999)).unwrap_err(),
        Refusal::BelowMinimum(350_000)
    );
    assert!(limits.reserve(seven(350_000)).is_ok());
}

/// A request whose records all exist already (a prefix recorded earlier) costs the sponsor a fee
/// and no float: it is held to the dust floor, not to the ladder that rations the float.
#[test]
fn a_request_that_creates_no_record_is_held_to_the_dust_floor_only() {
    let mut c = caps();
    c.float_cap = 10 * RENT;
    c.per_lock_max_percent = 100;
    let limits = SettlementLimits::new(c);
    land(&limits, settle(1, 1, 0, 9));
    assert!(limits.status(NOW).min_amount >= 5_000_000);
    let nothing_new =
        |amount: u64| request(Kind::Settlement, 2, 2, 100 * USDC, amount, vec![], NOW);
    assert_eq!(
        limits.reserve(nothing_new(49_999)).unwrap_err(),
        Refusal::BelowMinimum(50_000)
    );
    assert!(limits.reserve(nothing_new(50_000)).is_ok());
}

#[test]
fn the_number_of_locks_that_hold_records_is_bounded_and_a_lock_that_empties_frees_its_place() {
    let mut c = caps();
    c.max_locks = 3;
    c.max_locks_per_issuer = 3;
    let limits = SettlementLimits::new(c);
    for lock in 1..=3u8 {
        land(&limits, settle(lock, lock, u64::from(lock), 1));
    }
    assert_eq!(limits.status(NOW).locks, 3);
    assert_eq!(
        limits.reserve(settle(4, 4, 10, 1)).unwrap_err(),
        Refusal::TooManyLocks
    );
    // A lock that already holds records keeps its place.
    assert!(limits.reserve(settle(5, 1, 11, 1)).is_ok());
    limits.closed(&[address(1)]).unwrap();
    assert!(limits.reserve(settle(4, 4, 12, 1)).is_ok());
}

#[test]
fn an_issuer_key_holds_records_in_a_bounded_number_of_locks() {
    let limits = SettlementLimits::new(caps());
    let of_issuer = |lock: u8, first: u64| Request {
        issuer: [0xee; 33],
        ..settle(lock, lock, first, 1)
    };
    for lock in 1..=3u8 {
        land(&limits, of_issuer(lock, u64::from(lock)));
    }
    assert_eq!(
        limits.reserve(of_issuer(4, 10)).unwrap_err(),
        Refusal::IssuerLocks
    );
    // Another issuer is unaffected, and so is a further record of a lock the issuer already has.
    assert!(limits.reserve(settle(5, 5, 11, 1)).is_ok());
    assert!(limits.reserve(of_issuer(1, 12)).is_ok());
}

/// Every limit runs again right before the send, with what the gateway reads then: a bond that
/// was slashed in between, or a pressure that rose, refuses the send and releases the reservation.
#[test]
fn the_limits_are_checked_again_before_the_send() {
    let limits = SettlementLimits::new(caps());
    let reserved = limits.reserve(settle(1, 1, 0, 5)).unwrap();
    assert_eq!(
        reserved.begin(NOW, SLOT, 4 * USDC).unwrap_err(),
        Refusal::LockShare { allowed: 0 }
    );
    assert_eq!((limits.pending(), limits.open_records()), (0, 0));

    let mut c = caps();
    c.float_cap = 20 * RENT;
    c.per_lock_max_percent = 100;
    let limits = SettlementLimits::new(c);
    // At the time of the request nothing is lent: the minimum per record is the base one.
    let cheap = request(
        Kind::Settlement,
        1,
        1,
        1_000 * USDC,
        50_000,
        records(0, 1, NOW + 31 * DAY),
        NOW,
    );
    let held = limits.reserve(cheap).unwrap();
    // Other requests then lend 90 percent of the float.
    land(&limits, settle(2, 2, 100, 18));
    assert!(limits.status(NOW).min_amount >= 25_000_000);
    assert_eq!(
        held.begin(NOW, SLOT, 1_000 * USDC).unwrap_err(),
        Refusal::BelowMinimum(25_000_000)
    );
    // A reservation does not count against itself: the same request, alone, still begins.
    let alone = SettlementLimits::new(caps());
    let r = alone.reserve(settle(1, 1, 0, 3)).unwrap();
    assert!(r.begin(NOW, SLOT, 1_000 * USDC).is_ok());
}

/// The day's use alone raises the minimum, whatever the float: half of the daily cap is 50 percent.
#[test]
fn the_days_use_alone_raises_the_minimum() {
    let mut c = caps();
    c.daily_cap = 10;
    c.per_key_per_day = 100;
    c.per_prefix_per_day = 100;
    c.per_lock_per_day = 100;
    let limits = SettlementLimits::new(c);
    for i in 0..5u64 {
        let r = request(Kind::Settlement, i as u8, 1, 100 * USDC, USDC, vec![], NOW);
        begin(limits.reserve(r).unwrap(), 100 * USDC)
            .landed(SLOT)
            .unwrap();
    }
    let status = limits.status(NOW);
    assert_eq!(status.open_float, 0);
    assert_eq!(status.pressure_percent, 50);
    assert_eq!(status.min_amount, 250_000);
}

/// Exactly `preparing_per_prefix` requests of one network may be held at once.
#[test]
fn exactly_the_preparing_limit_of_one_network_is_held_and_one_more_is_refused() {
    let mut c = caps();
    c.per_key_per_day = 100;
    let limits = SettlementLimits::new(c);
    let from_one_network = |first: u64, key: u8| Request {
        prefix: net(1),
        ..settle(key, key, first, 1)
    };
    let held: Vec<Reservation> = (0..8u8)
        .map(|i| {
            limits
                .reserve(from_one_network(u64::from(i), i + 1))
                .unwrap()
        })
        .collect();
    assert_eq!(
        limits.reserve(from_one_network(8, 9)).unwrap_err(),
        Refusal::PrefixBusy
    );
    drop(held);
    assert!(limits.reserve(from_one_network(8, 9)).is_ok());
}

#[test]
fn many_reservations_before_any_send_stay_within_the_caps() {
    let mut c = caps();
    c.steps.clear();
    c.max_locks = 1_000;
    c.max_locks_per_issuer = 1_000;
    let limits = SettlementLimits::new(c);
    let mut held = vec![];
    for i in 0..400u64 {
        let r = request(
            Kind::Settlement,
            (i % 200) as u8,
            (i % 50) as u8,
            1_000 * USDC,
            4 * USDC,
            records(i * 4, 4, NOW + 31 * DAY),
            NOW,
        );
        match limits.reserve(r) {
            Ok(reservation) => held.push(reservation),
            Err(Refusal::FloatCap) => break,
            Err(_) => {}
        }
    }
    let status = limits.status(NOW);
    assert!(status.open_float <= 1_000_000_000, "{status:?}");
    assert!(
        status.open_float + 4 * RENT > 1_000_000_000,
        "refused only at the cap"
    );
    drop(held);
    assert_eq!(limits.status(NOW).open_float, 0);
}

/// A change of one setting cannot make the places cheaper to occupy than the float: the bond that
/// fills every place is at least the bond that fills the cap.
#[test]
fn the_pilot_values_keep_the_places_dearer_than_the_float() {
    let c = caps();
    let cap_records = c.float_cap / RENT;
    assert!(u64::from(c.max_locks) * c.min_bond >= cap_records * c.bond_per_record);
}
