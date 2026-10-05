use buckspay_gateway::float::*;
use proptest::prelude::*;
use std::collections::HashSet;

mod float_support;
use float_support::*;

#[test]
fn limits_survive_a_restart_and_a_pending_reservation_does_not() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settlements.json");
    let limits = SettlementLimits::open(caps(), &path).unwrap();
    land(&limits, settle(1, 1, 0, 2));
    begin(limits.reserve(settle(2, 2, 10, 1)).unwrap(), 1_000 * USDC)
        .unknown()
        .unwrap();
    let pending = limits.reserve(settle(3, 3, 20, 1)).unwrap();
    let before = (
        limits.open_records(),
        limits.unknown_sends(),
        limits.sponsored_by_prefix(net(1), NOW),
        limits.counter_rows(),
    );
    std::mem::forget(pending);
    drop(limits);
    let reopened = SettlementLimits::open(caps(), &path).unwrap();
    let after = (
        reopened.open_records(),
        reopened.unknown_sends(),
        reopened.sponsored_by_prefix(net(1), NOW),
        reopened.counter_rows(),
    );
    assert_eq!(before, after);
    assert_eq!(
        reopened.pending(),
        0,
        "a reservation is never persisted: nothing was written down for it"
    );
    assert_eq!(reopened.open_of_lock(&[1; 32]), 2);
    // The caps still hold after the restart: the same key's counter continues.
    assert_eq!(reopened.sponsored_by_prefix(net(2), NOW), 1);
}

#[test]
fn counters_are_swept_after_their_window_and_the_table_is_bounded_by_the_daily_cap() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settlements.json");
    let mut c = caps();
    c.daily_cap = 40;
    c.steps.clear();
    let limits = SettlementLimits::open(c, &path).unwrap();
    for i in 0..40u8 {
        let r = request(
            Kind::Settlement,
            i,
            i,
            100 * USDC,
            USDC,
            records(u64::from(i), 1, NOW + 31 * DAY),
            NOW,
        );
        land(&limits, r);
        limits.closed(&[address(u64::from(i))]).unwrap();
    }
    assert_eq!(
        limits.counter_rows(),
        120,
        "one row per network, key and lock, for one day"
    );
    let over = request(
        Kind::Settlement,
        99,
        99,
        100 * USDC,
        USDC,
        records(99, 1, NOW + 31 * DAY),
        NOW,
    );
    assert_eq!(limits.reserve(over).unwrap_err(), Refusal::DailyCap);
    // 29 days later nothing is swept; on the 30th day the oldest day is gone.
    limits.status(NOW + 29 * DAY);
    assert_eq!(limits.counter_rows(), 120);
    limits.status(NOW + 31 * DAY);
    assert_eq!(limits.counter_rows(), 0);
    limits.closed(&[]).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    for table in ["networks", "keys", "locks"] {
        assert!(
            json[table].as_object().unwrap().is_empty(),
            "{table}: {text}"
        );
    }
    // And the daily count has rolled: sponsoring resumes.
    let again = request(
        Kind::Settlement,
        1,
        1,
        100 * USDC,
        USDC,
        records(500, 1, NOW + 62 * DAY),
        NOW + 31 * DAY,
    );
    assert!(limits.reserve(again).is_ok());
}

#[test]
fn a_failed_send_counts_toward_the_limits_but_not_the_float() {
    let limits = SettlementLimits::new(caps());
    for i in 0..20u64 {
        let r = request(
            Kind::Settlement,
            1,
            1,
            100 * USDC,
            2 * USDC,
            records(i * 2, 2, NOW + 31 * DAY),
            NOW,
        );
        begin(limits.reserve(r).unwrap(), 100 * USDC)
            .failed(10_000)
            .unwrap();
    }
    assert_eq!(
        limits.open_records(),
        0,
        "no record exists after a failed transaction"
    );
    assert_eq!(limits.failed_fees(), 200_000);
    let next = request(
        Kind::Settlement,
        1,
        1,
        100 * USDC,
        2 * USDC,
        records(50, 2, NOW + 31 * DAY),
        NOW,
    );
    assert_eq!(limits.reserve(next).unwrap_err(), Refusal::KeySpentToday);
    assert_eq!(limits.status(NOW).open_float, 0);
}

#[test]
fn every_send_counts_once_against_its_lock_and_its_day() {
    let mut c = caps();
    c.per_lock_per_day = 3;
    c.daily_cap = 5;
    c.per_lock_max_percent = 100;
    c.steps.clear();
    let limits = SettlementLimits::new(c);
    let ask = |key: u8, first: u64| {
        request(
            Kind::Settlement,
            key,
            9,
            1_000 * USDC,
            USDC,
            records(first, 1, NOW + 31 * DAY),
            NOW,
        )
    };
    let b = 1_000 * USDC;
    // Three requests of one lock from three keys and networks: the fourth is the lock's day.
    land(&limits, ask(1, 0));
    begin(limits.reserve(ask(2, 1)).unwrap(), b)
        .unknown()
        .unwrap();
    begin(limits.reserve(ask(3, 2)).unwrap(), b)
        .failed(5_000)
        .unwrap();
    assert_eq!(
        limits.reserve(ask(4, 3)).unwrap_err(),
        Refusal::LockSpentToday
    );
    // Another lock still has the day's room: 3 of 5 requests are used, and each counted once.
    let other = |key: u8, first: u64| {
        request(
            Kind::Settlement,
            key,
            8,
            1_000 * USDC,
            USDC,
            records(first, 1, NOW + 31 * DAY),
            NOW,
        )
    };
    land(&limits, other(5, 10));
    begin(limits.reserve(other(6, 11)).unwrap(), b)
        .failed(5_000)
        .unwrap();
    assert_eq!(limits.reserve(other(7, 12)).unwrap_err(), Refusal::DailyCap);
}

#[test]
fn an_unknown_outcome_counts_as_unknown_and_as_sent() {
    let limits = SettlementLimits::new(caps());
    begin(limits.reserve(settle(1, 1, 0, 2)).unwrap(), 1_000 * USDC)
        .unknown()
        .unwrap();
    assert_eq!((limits.open_records(), limits.unknown_sends()), (2, 1));
    assert_eq!(limits.sponsored_by_prefix(net(1), NOW), 1);
}

#[test]
fn a_request_that_is_refused_or_dropped_keeps_nothing() {
    let limits = SettlementLimits::new(caps());
    let reservation = limits.reserve(settle(1, 1, 0, 2)).unwrap();
    assert_eq!(limits.pending(), 1);
    drop(reservation);
    assert_eq!(
        (
            limits.pending(),
            limits.open_records(),
            limits.counter_rows()
        ),
        (0, 0, 0)
    );
    let refused = request(
        Kind::Settlement,
        1,
        1,
        0,
        1,
        records(5, 1, NOW + 31 * DAY),
        NOW,
    );
    assert!(limits.reserve(refused).is_err());
    assert_eq!(
        (
            limits.pending(),
            limits.open_records(),
            limits.counter_rows()
        ),
        (0, 0, 0)
    );
}

#[test]
fn a_reservation_that_was_swept_is_not_sent() {
    let limits = SettlementLimits::new(caps());
    let reservation = limits.reserve(settle(1, 1, 0, 1)).unwrap();
    assert_eq!(
        reservation.begin(NOW + 91, SLOT, 1_000 * USDC).unwrap_err(),
        Refusal::Expired
    );
    assert_eq!(
        (
            limits.pending(),
            limits.open_records(),
            limits.counter_rows()
        ),
        (0, 0, 0)
    );
    let alive = limits.reserve(settle(1, 1, 0, 1)).unwrap();
    assert!(alive.begin(NOW + 89, SLOT, 1_000 * USDC).is_ok());
}

#[test]
fn the_ledger_never_holds_a_key_a_wallet_or_a_network_next_to_one() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("settlements.json");
    let limits = SettlementLimits::open(caps(), &path).unwrap();
    let key = [0xab; 33];
    let r = Request {
        key,
        ..settle(1, 1, 0, 1)
    };
    land(&limits, r);
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(!text.contains(&"ab".repeat(33)), "no raw key");
    assert!(
        !text.contains(&"ab".repeat(8)),
        "no prefix of the key either"
    );
    let json: serde_json::Value = serde_json::from_str(&text).unwrap();
    let networks: Vec<&String> = json["networks"].as_object().unwrap().keys().collect();
    let keys: Vec<&String> = json["keys"].as_object().unwrap().keys().collect();
    assert_eq!((networks.len(), keys.len()), (1, 1));
    assert!(
        networks[0].contains('/') && !keys[0].contains('/'),
        "separate tables, no joint row"
    );
    for table in ["networks", "keys", "locks"] {
        for days in json[table].as_object().unwrap().values() {
            assert!(
                days.as_object()
                    .unwrap()
                    .values()
                    .all(serde_json::Value::is_number),
                "counts only"
            );
        }
    }
}

#[test]
fn an_unwritable_ledger_stops_the_sponsoring_and_nothing_is_sent_without_being_written() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing").join("settlements.json");
    let limits = SettlementLimits::open(caps(), &path).unwrap();
    let reservation = limits.reserve(settle(1, 1, 0, 1)).unwrap();
    // The send is written down before it is made: a ledger that cannot be written refuses it.
    assert_eq!(
        reservation.begin(NOW, SLOT, 1_000 * USDC).unwrap_err(),
        Refusal::Unwritable
    );
    assert_eq!(
        (limits.open_records(), limits.counter_rows()),
        (0, 0),
        "the refused send left nothing in memory either"
    );
    assert_eq!(
        limits.reserve(settle(2, 2, 10, 1)).unwrap_err(),
        Refusal::Unwritable
    );
}

/// Every lock has one bond, the same in every request that names it, and one issuer key.
fn bond_of(lock: u8) -> u64 {
    (u64::from(lock) + 1) * 12 * USDC
}

#[derive(Clone, Debug)]
enum Op {
    Reserve {
        key: u8,
        lock: u8,
        records: u8,
    },
    Begin(usize),
    Land(usize),
    Unknown(usize),
    Failed(usize),
    /// The process dies after the send was written down: the intent is all that is left.
    Crash(usize),
    Release(usize),
    Close(u8),
    Reconcile,
    Advance(u32),
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        6 => (0u8..30, 0u8..4, 1u8..8).prop_map(|(key, lock, records)| Op::Reserve { key, lock, records }),
        3 => (0usize..16).prop_map(Op::Begin),
        2 => (0usize..16).prop_map(Op::Land),
        1 => (0usize..16).prop_map(Op::Unknown),
        1 => (0usize..16).prop_map(Op::Failed),
        1 => (0usize..16).prop_map(Op::Crash),
        2 => (0usize..16).prop_map(Op::Release),
        2 => (1u8..40).prop_map(Op::Close),
        1 => Just(Op::Reconcile),
        2 => (0u32..3 * DAY).prop_map(Op::Advance),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    /// Whatever happens, the rent the gateway has out never exceeds the cap, no lock holds more
    /// open records than its bond allows, the locks that hold records stay within their number,
    /// and a reservation that was refused leaves no trace. A crash after the intent was written
    /// changes nothing the limits count.
    #[test]
    fn the_float_the_share_and_the_locks_are_never_exceeded(ops in proptest::collection::vec(op(), 1..120)) {
        let mut c = caps();
        c.float_cap = 60 * RENT;
        c.steps.clear();
        c.per_key_per_day = 6;
        c.per_lock_per_day = 25;
        c.max_locks = 3;
        c.max_locks_per_issuer = 2;
        let limits = SettlementLimits::new(c.clone());
        let mut held: Vec<(Reservation, u8)> = vec![];
        let mut sending: Vec<Sending> = vec![];
        let mut next = 0u64;
        let mut now = NOW;
        let mut slot = SLOT;
        let on_chain: HashSet<[u8; 32]> = HashSet::new();
        for o in ops {
            match o {
                Op::Reserve { key, lock, records: n } => {
                    let before = (limits.pending(), limits.open_records());
                    let issuer = [lock % 2; 33];
                    let r = Request { issuer, ..request(Kind::Settlement, key, lock, bond_of(lock), u64::from(n) * USDC, records(next, u64::from(n), now + 31 * DAY), now) };
                    match limits.reserve(r) {
                        Ok(reservation) => { held.push((reservation, lock)); next += u64::from(n); }
                        Err(_) => prop_assert_eq!((limits.pending(), limits.open_records()), before),
                    }
                }
                // The gateway writes the send down, then sends: from there on only the janitor
                // can resolve it, with or without the answer of the send.
                Op::Begin(i) => {
                    if !held.is_empty() {
                        let (r, lock) = held.swap_remove(i % held.len());
                        if let Ok(s) = r.begin(now, slot, bond_of(lock)) { sending.push(s); }
                    }
                }
                Op::Land(i) => { if !sending.is_empty() { sending.swap_remove(i % sending.len()).landed(slot).unwrap(); } }
                Op::Unknown(i) => { if !sending.is_empty() { sending.swap_remove(i % sending.len()).unknown().unwrap(); } }
                Op::Failed(i) => { if !sending.is_empty() { sending.swap_remove(i % sending.len()).failed(5_000).unwrap(); } }
                Op::Crash(i) => { if !sending.is_empty() { drop(sending.swap_remove(i % sending.len())); } }
                Op::Release(i) => { if !held.is_empty() { drop(held.swap_remove(i % held.len())); } }
                Op::Close(k) => { limits.closed(&[address(u64::from(k))]).unwrap(); }
                Op::Reconcile => { slot += 1_000; limits.reconcile(&Read { slot, existing: on_chain.clone() }, now).unwrap(); }
                Op::Advance(s) => { now += s; slot += u64::from(s); limits.status(now); }
            }
            let status = limits.status(now);
            prop_assert!(status.open_float <= c.float_cap, "{status:?}");
            prop_assert!(status.locks as u32 <= c.max_locks, "{status:?}");
            for lock in 0..4u8 {
                prop_assert!(limits.open_of_lock(&[lock; 32]) as u32 <= limits.lock_share(bond_of(lock), RENT));
            }
        }
    }
}
