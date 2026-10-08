use buckspay_gateway::float::*;
use std::collections::HashSet;

mod float_support;
use float_support::*;

#[test]
fn begin_all_admits_cumulatively_within_one_lock() {
    let mut c = caps();
    c.float_cap = 100 * RENT;
    c.per_lock_max_percent = 100;
    c.steps.clear();
    let limits = SettlementLimits::new(c);
    let share = limits.lock_share(1_000 * USDC, RENT);
    let half = u64::from(share / 2);
    let a = limits.reserve(settle(1, 7, 0, half)).unwrap();
    let b = limits.reserve(settle(2, 7, 100, half)).unwrap();
    // Both fit the share of the bond they were reserved with; the lock's bond, read again before the
    // send, is lower, and only the second does not fit with the first counted.
    let lower = 60 * USDC;
    let refused = limits
        .begin_all(vec![a, b], NOW, SLOT, &[lower, lower])
        .unwrap_err();
    assert_eq!(refused.0, 1);
    assert!(
        matches!(refused.1, Refusal::LockShare { allowed: 60 }),
        "{:?}",
        refused.1
    );
    assert_eq!(
        (limits.open_records(), limits.pending()),
        (0, 0),
        "nothing begun, every reservation released"
    );
}

#[test]
fn begin_all_writes_every_record_once() {
    let limits = SettlementLimits::new(caps());
    let rs = (0..3)
        .map(|i| limits.reserve(settle(i, i, u64::from(i) * 10, 2)).unwrap())
        .collect();
    let sending = limits.begin_all(rs, NOW, SLOT, &[1_000 * USDC; 3]).unwrap();
    assert_eq!(limits.open_records(), 6);
    sending.landed(SLOT + 1).unwrap();
    assert_eq!(limits.open_records(), 6);
}

#[test]
fn a_failed_transaction_releases_all_its_records() {
    let limits = SettlementLimits::new(caps());
    let rs = (0..2)
        .map(|i| limits.reserve(settle(i, i, u64::from(i) * 10, 2)).unwrap())
        .collect();
    limits
        .begin_all(rs, NOW, SLOT, &[1_000 * USDC; 2])
        .unwrap()
        .failed(10_000)
        .unwrap();
    assert_eq!((limits.open_records(), limits.failed_fees()), (0, 10_000));
}

#[test]
fn an_unknown_transaction_keeps_its_records_until_a_newer_read() {
    let c = caps();
    let (slots, grace) = (c.intent_slots, c.unknown_grace);
    let limits = SettlementLimits::new(c);
    let rs = (0..2)
        .map(|i| limits.reserve(settle(i, i, u64::from(i) * 10, 2)).unwrap())
        .collect();
    limits
        .begin_all(rs, NOW, SLOT, &[1_000 * USDC; 2])
        .unwrap()
        .unknown()
        .unwrap();
    let stale = Read {
        slot: SLOT + slots - 1,
        existing: HashSet::new(),
    };
    limits.reconcile(&stale, NOW + grace + 1).unwrap();
    assert_eq!(
        limits.open_records(),
        4,
        "released on a read that cannot know"
    );
    let newer = Read {
        slot: SLOT + slots,
        existing: HashSet::new(),
    };
    limits.reconcile(&newer, NOW + grace + 1).unwrap();
    assert_eq!(limits.open_records(), 0);
}
