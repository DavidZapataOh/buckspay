use buckspay_gateway::sponsor::*;
use std::{net::IpAddr, sync::Arc};

const COSTS: Costs = Costs {
    permanent: 924_160,
    float: 3_622_040,
};
/// The default minimum (2 USDC), so tests of the other limits stay unaffected by the escalation.
const FUNDING: u64 = 2_000_000;

fn caps() -> Caps {
    Caps {
        cac_budget: 500_000_000,
        open_rent_cap: 600_000_000,
        daily_onboardings: 200,
        per_prefix_per_day: 5,
        per_prefix_per_30_days: 10,
        preparing_per_prefix: 3,
        escalation: Escalation {
            base_min_funding: FUNDING,
            steps: Vec::new(),
            fee_on_percent: 101,
            fee_off_percent: 101,
        },
    }
}

/// The pilot ladder on top of the same caps.
fn escalating() -> Caps {
    Caps {
        escalation: Escalation::default(),
        ..caps()
    }
}

fn net(a: u8) -> Prefix {
    Prefix::from(IpAddr::from([203, 0, a, 9]))
}

#[test]
fn a_reservation_is_charged_to_the_network_that_prepared_it_not_the_one_that_submits() {
    let limits = SponsorLimits::new(caps());
    let r = limits
        .reserve(net(1), Kind::Onboard, COSTS, 100, FUNDING)
        .unwrap();
    // The submit arrives from another network: the commit still lands on network 1.
    r.commit().unwrap();
    assert_eq!(limits.sponsored_by(net(1), 100), 1);
    assert_eq!(limits.sponsored_by(net(2), 100), 0);
    assert_eq!((limits.cac_spent(), limits.open_locks()), (924_160, 1));
}

#[test]
fn many_prepares_before_any_submit_are_bounded_per_network_and_globally() {
    let limits = SponsorLimits::new(caps());
    let mut held = Vec::new();
    for _ in 0..3 {
        held.push(
            limits
                .reserve(net(1), Kind::Onboard, COSTS, 100, FUNDING)
                .unwrap(),
        );
    }
    assert_eq!(
        limits
            .reserve(net(1), Kind::Onboard, COSTS, 100, FUNDING)
            .err(),
        Some(Refusal::PrefixBusy)
    );
    // Other networks still work, until the global float cap is reached by reservations alone.
    let mut n = 0u8;
    let refusal = loop {
        n += 1;
        match limits.reserve(net(10 + n), Kind::Onboard, COSTS, 100, FUNDING) {
            Ok(r) => held.push(r),
            Err(e) => break e,
        }
    };
    assert_eq!(refusal, Refusal::OpenRentCap);
    assert_eq!(
        held.len() as u64,
        600_000_000 / COSTS.float,
        "165 simultaneous reservations fit the 0.6 SOL cap"
    );
    assert_eq!(limits.cac_spent(), 0, "nothing was spent yet");
}

#[test]
fn dropped_reservations_release_the_network_the_cac_budget_and_the_float() {
    let limits = SponsorLimits::new(caps());
    {
        let _a = limits
            .reserve(net(1), Kind::Onboard, COSTS, 100, FUNDING)
            .unwrap();
        let _b = limits
            .reserve(net(1), Kind::Onboard, COSTS, 100, FUNDING)
            .unwrap();
        assert_eq!(limits.preparing(), 2);
    }
    assert_eq!(limits.preparing(), 0);
    // After the drop the whole budget is available again: spend it down to the last key.
    let mut committed = 0u64;
    for i in 0..300u32 {
        let prefix = net((i % 250) as u8 + 1);
        let day = 100 + u64::from(i / 200);
        let Ok(r) = limits.reserve(
            prefix,
            Kind::Onboard,
            Costs {
                permanent: COSTS.permanent,
                float: 0,
            },
            day,
            FUNDING,
        ) else {
            continue;
        };
        r.commit().unwrap();
        committed += 1;
    }
    assert!(committed <= 500_000_000 / COSTS.permanent);
    assert_eq!(limits.cac_spent(), committed * COSTS.permanent);
}

#[test]
fn the_cac_budget_is_exact_to_the_lamport() {
    let mut c = caps();
    c.cac_budget = 2 * COSTS.permanent;
    c.open_rent_cap = u64::MAX;
    let limits = SponsorLimits::new(c);
    limits
        .reserve(net(1), Kind::Onboard, COSTS, 1, FUNDING)
        .unwrap()
        .commit()
        .unwrap();
    limits
        .reserve(net(2), Kind::Onboard, COSTS, 1, FUNDING)
        .unwrap()
        .commit()
        .unwrap();
    assert_eq!(
        limits
            .reserve(net(3), Kind::Onboard, COSTS, 1, FUNDING)
            .err(),
        Some(Refusal::CacBudget)
    );
    // A later lock of a registered key spends no CAC.
    limits
        .reserve(net(3), Kind::Lock, COSTS, 1, FUNDING)
        .unwrap();
}

#[test]
fn committed_open_locks_and_reservations_both_count_against_the_float_cap() {
    let mut c = caps();
    c.open_rent_cap = 3 * COSTS.float;
    let limits = SponsorLimits::new(c);
    limits
        .reserve(net(1), Kind::Lock, COSTS, 1, FUNDING)
        .unwrap()
        .commit()
        .unwrap();
    limits
        .reserve(net(2), Kind::Lock, COSTS, 1, FUNDING)
        .unwrap()
        .commit()
        .unwrap();
    let pending = limits
        .reserve(net(3), Kind::Lock, COSTS, 1, FUNDING)
        .unwrap();
    assert_eq!(
        limits.reserve(net(4), Kind::Lock, COSTS, 1, FUNDING).err(),
        Some(Refusal::OpenRentCap)
    );
    drop(pending);
    limits
        .reserve(net(4), Kind::Lock, COSTS, 1, FUNDING)
        .unwrap();
}

#[test]
fn closes_free_float_and_reconcile_sets_the_count_to_the_chain() {
    let mut c = caps();
    c.open_rent_cap = 2 * COSTS.float;
    let limits = SponsorLimits::new(c);
    limits
        .reserve(net(1), Kind::Lock, COSTS, 1, FUNDING)
        .unwrap()
        .commit()
        .unwrap();
    limits
        .reserve(net(2), Kind::Lock, COSTS, 1, FUNDING)
        .unwrap()
        .commit()
        .unwrap();
    assert_eq!(
        limits.reserve(net(3), Kind::Lock, COSTS, 1, FUNDING).err(),
        Some(Refusal::OpenRentCap)
    );
    limits.closed(1).unwrap();
    limits
        .reserve(net(3), Kind::Lock, COSTS, 1, FUNDING)
        .unwrap()
        .commit()
        .unwrap();
    limits.reconcile_open_locks(0).unwrap(); // the chain says all are closed
    assert_eq!(limits.open_locks(), 0);
    limits.closed(5).unwrap(); // never underflows
    assert_eq!(limits.open_locks(), 0);
}

#[test]
fn the_daily_cap_and_the_network_day_reset_on_a_new_day_but_the_cac_total_does_not() {
    let mut c = caps();
    c.daily_onboardings = 2;
    c.per_prefix_per_day = 1;
    c.open_rent_cap = u64::MAX;
    let limits = SponsorLimits::new(c);
    limits
        .reserve(net(1), Kind::Onboard, COSTS, 5, FUNDING)
        .unwrap()
        .commit()
        .unwrap();
    assert_eq!(
        limits
            .reserve(net(1), Kind::Onboard, COSTS, 5, FUNDING)
            .err(),
        Some(Refusal::PrefixSpentToday)
    );
    limits
        .reserve(net(2), Kind::Onboard, COSTS, 5, FUNDING)
        .unwrap()
        .commit()
        .unwrap();
    assert_eq!(
        limits
            .reserve(net(3), Kind::Onboard, COSTS, 5, FUNDING)
            .err(),
        Some(Refusal::DailyCap)
    );
    limits
        .reserve(net(1), Kind::Onboard, COSTS, 6, FUNDING)
        .unwrap()
        .commit()
        .unwrap(); // next day
    assert_eq!(limits.cac_spent(), 3 * COSTS.permanent);
}

#[test]
fn a_network_may_sponsor_ten_in_thirty_days_and_the_window_slides() {
    let mut c = caps();
    c.per_prefix_per_day = 100;
    c.open_rent_cap = u64::MAX;
    c.daily_onboardings = 1_000;
    let limits = SponsorLimits::new(c);
    for day in 0..10u64 {
        limits
            .reserve(net(1), Kind::Onboard, COSTS, day, FUNDING)
            .unwrap()
            .commit()
            .unwrap();
    }
    assert_eq!(
        limits
            .reserve(net(1), Kind::Onboard, COSTS, 20, FUNDING)
            .err(),
        Some(Refusal::PrefixSpentThisMonth)
    );
    limits
        .reserve(net(1), Kind::Onboard, COSTS, 30, FUNDING)
        .unwrap()
        .commit()
        .unwrap();
    // day 0 left the window
}

#[test]
fn the_ledger_survives_a_restart_and_holds_no_wallet_key_or_time_of_day() {
    let dir = std::env::temp_dir().join(format!("sponsor-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("ledger.json");
    let _ = std::fs::remove_file(&path);
    let limits = SponsorLimits::open(caps(), &path).unwrap();
    limits
        .reserve(net(1), Kind::Onboard, COSTS, 100, FUNDING)
        .unwrap()
        .commit()
        .unwrap();
    limits
        .reserve(net(2), Kind::Lock, COSTS, 100, FUNDING)
        .unwrap()
        .commit()
        .unwrap();
    drop(limits);

    let again = SponsorLimits::open(caps(), &path).unwrap();
    assert_eq!((again.cac_spent(), again.open_locks()), (924_160, 2));
    assert_eq!(again.sponsored_by(net(1), 100), 1);
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(
        !text.contains("wallet") && !text.contains("key") && !text.contains("time"),
        "{text}"
    );
    // Only day numbers, counts and network prefixes.
    assert!(text.contains("203.0.1.0/24") && text.contains("\"cac_spent\":924160"));
}

#[test]
fn concurrent_reserves_never_overshoot_any_cap() {
    let mut c = caps();
    c.open_rent_cap = 10 * COSTS.float;
    c.per_prefix_per_day = 1_000;
    c.per_prefix_per_30_days = 1_000;
    c.preparing_per_prefix = 1_000;
    let limits = SponsorLimits::new(c);
    let held = Arc::new(std::sync::Mutex::new(Vec::new()));
    let handles: Vec<_> = (0..32u8)
        .map(|i| {
            let (limits, held) = (Arc::clone(&limits), Arc::clone(&held));
            std::thread::spawn(move || {
                for _ in 0..4 {
                    if let Ok(r) = limits.reserve(net(i + 1), Kind::Onboard, COSTS, 7, FUNDING) {
                        held.lock().unwrap().push(r);
                    }
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    assert_eq!(
        held.lock().unwrap().len(),
        10,
        "exactly the cap, never more"
    );
}

#[test]
fn a_send_that_fails_on_chain_costs_its_fee_and_the_network_a_slot_but_opens_no_lock() {
    let limits = SponsorLimits::new(caps());
    limits
        .reserve(net(1), Kind::Onboard, COSTS, 100, FUNDING)
        .unwrap()
        .failed(10_000)
        .unwrap();
    assert_eq!((limits.cac_spent(), limits.open_locks()), (10_000, 0));
    assert_eq!(limits.sponsored_by(net(1), 100), 1);
    // Repeating it from one network runs into that network's daily limit after five tries.
    for _ in 0..4 {
        limits
            .reserve(net(1), Kind::Onboard, COSTS, 100, FUNDING)
            .unwrap()
            .failed(10_000)
            .unwrap();
    }
    assert_eq!(
        limits
            .reserve(net(1), Kind::Onboard, COSTS, 100, FUNDING)
            .err(),
        Some(Refusal::PrefixSpentToday)
    );
}

#[test]
fn cost_plus_fee_follows_the_sol_price() {
    // 924,160 lamports, 10% markup, step 0.05 USDC (50,000 base units), price in micro-USDC per SOL.
    for (price, expected) in [
        (80_000_000, 100_000),
        (120_490_000, 150_000),
        (150_000_000, 200_000),
        (300_000_000, 350_000),
    ] {
        assert_eq!(
            cost_plus_fee(924_160, 110, price, 50_000),
            Some(expected),
            "SOL at {price} micro-USDC"
        );
    }
    assert_eq!(cost_plus_fee(0, 110, 120_490_000, 50_000), Some(0));
    assert_eq!(
        cost_plus_fee(1, 110, 1, 50_000),
        Some(50_000),
        "rounds up, never down to zero"
    );
    assert_eq!(
        cost_plus_fee(u64::MAX, 110, u64::MAX, 50_000),
        None,
        "an overflow is a refusal to quote, not a wrapped number"
    );
}

/// Opens `n` more committed locks, each from a network of its own (a /24), at the minimum in force.
fn open_locks(limits: &Arc<SponsorLimits>, n: u64) {
    let start = limits.open_locks();
    for i in start..start + n {
        let prefix = Prefix::from(IpAddr::from([198, (i / 250) as u8, (i % 250) as u8, 9]));
        let min = limits.status(FeeMode::Off, COSTS, 1).min_funding;
        limits
            .reserve(prefix, Kind::Lock, COSTS, 1, min)
            .unwrap()
            .commit()
            .unwrap();
    }
}

#[test]
fn below_half_of_every_cap_nothing_changes() {
    let limits = SponsorLimits::new(escalating());
    open_locks(&limits, 82); // 82 x 3,622,040 = 297,007,280 of 600,000,000: 49 percent
    let status = limits.status(FeeMode::Off, COSTS, 1);
    assert_eq!(
        status,
        Status {
            pressure_percent: 49,
            min_funding: 2_000_000,
            fee_mode: FeeMode::Off
        }
    );
}

#[test]
fn open_rent_past_half_raises_the_minimum_step_by_step_and_forces_cost_plus() {
    let limits = SponsorLimits::new(escalating());
    let mut seen = Vec::new();
    for n in 1..=165u64 {
        open_locks(&limits, 1);
        let st = limits.status(FeeMode::Off, COSTS, 1);
        if seen.last().map(|(_, m, f)| (*m, *f)) != Some((st.min_funding, st.fee_mode)) {
            seen.push((n, st.min_funding, st.fee_mode));
        }
    }
    // (locks open when the step is first seen, minimum funding, fee mode)
    assert_eq!(
        seen,
        vec![
            (1, 2_000_000, FeeMode::Off),
            (83, 5_000_000, FeeMode::CostPlus),
            (108, 10_000_000, FeeMode::CostPlus),
            (133, 25_000_000, FeeMode::CostPlus),
            (150, 50_000_000, FeeMode::CostPlus),
        ]
    );
}

#[test]
fn the_days_onboardings_past_half_of_the_daily_cap_escalate_too() {
    let mut c = escalating();
    c.open_rent_cap = u64::MAX; // only the daily cap can raise the pressure
    c.per_prefix_per_day = 1_000;
    c.per_prefix_per_30_days = 1_000;
    let limits = SponsorLimits::new(c);
    let onboard = |i: u32| {
        let prefix = Prefix::from(IpAddr::from([192, 0, i as u8, 9]));
        limits
            .reserve(
                prefix,
                Kind::Onboard,
                COSTS,
                7,
                FUNDING.max(limits.status(FeeMode::Off, COSTS, 7).min_funding),
            )
            .unwrap()
            .commit()
            .unwrap();
    };
    for i in 0..99 {
        onboard(i);
    }
    assert_eq!(
        limits.status(FeeMode::Off, COSTS, 7),
        Status {
            pressure_percent: 49,
            min_funding: 2_000_000,
            fee_mode: FeeMode::Off
        }
    );
    onboard(99);
    assert_eq!(
        limits.status(FeeMode::Off, COSTS, 7),
        Status {
            pressure_percent: 50,
            min_funding: 5_000_000,
            fee_mode: FeeMode::CostPlus
        }
    );
    // The next day the counter resets and so does the pressure; the fee lever is released (below 40 percent).
    assert_eq!(
        limits.status(FeeMode::Off, COSTS, 8),
        Status {
            pressure_percent: 0,
            min_funding: 2_000_000,
            fee_mode: FeeMode::Off
        }
    );
}

#[test]
fn a_request_below_the_current_minimum_is_refused_and_takes_nothing() {
    let limits = SponsorLimits::new(escalating());
    open_locks(&limits, 83); // 50 percent
    assert_eq!(
        limits
            .reserve(net(1), Kind::Onboard, COSTS, 1, 2_000_000)
            .err(),
        Some(Refusal::BelowMinimum(5_000_000))
    );
    assert_eq!(
        limits
            .reserve(net(1), Kind::Onboard, COSTS, 1, 4_999_999)
            .err(),
        Some(Refusal::BelowMinimum(5_000_000))
    );
    assert_eq!(
        (limits.preparing(), limits.cac_spent()),
        (0, 0),
        "a refusal reserves nothing"
    );
    limits
        .reserve(net(1), Kind::Onboard, COSTS, 1, 5_000_000)
        .unwrap();
}

#[test]
fn the_forced_fee_lever_is_released_only_below_forty_percent() {
    let limits = SponsorLimits::new(escalating());
    open_locks(&limits, 83);
    assert_eq!(
        limits.status(FeeMode::Off, COSTS, 1).fee_mode,
        FeeMode::CostPlus
    );
    limits.closed(10).unwrap(); // 73 locks: 44 percent, between the two thresholds
    let between = limits.status(FeeMode::Off, COSTS, 1);
    assert_eq!(
        (
            between.pressure_percent,
            between.min_funding,
            between.fee_mode
        ),
        (44, 2_000_000, FeeMode::CostPlus)
    );
    limits.closed(10).unwrap(); // 63 locks: 38 percent
    assert_eq!(limits.status(FeeMode::Off, COSTS, 1).fee_mode, FeeMode::Off);
}

#[test]
fn the_operators_cost_plus_setting_is_never_lowered_by_the_escalation() {
    let limits = SponsorLimits::new(escalating());
    assert_eq!(
        limits.status(FeeMode::CostPlus, COSTS, 1).fee_mode,
        FeeMode::CostPlus
    );
}

#[test]
fn an_attacker_who_never_opens_a_token_account_pays_the_whole_ladder_to_fill_the_cap() {
    // The attacker onboards from fresh networks and closes its token account so nothing can release
    // the locks. Each lock must carry the minimum in force when it is reserved.
    let limits = SponsorLimits::new(escalating());
    let mut capital = 0u64;
    let mut locks = 0u64;
    loop {
        let min = limits.status(FeeMode::Off, COSTS, 1).min_funding;
        let prefix = Prefix::from(IpAddr::from([
            100,
            (locks / 250) as u8,
            (locks % 250) as u8,
            9,
        ]));
        match limits.reserve(prefix, Kind::Lock, COSTS, 1, min) {
            Ok(r) => {
                r.commit().unwrap();
                capital += min;
                locks += 1;
            }
            Err(Refusal::OpenRentCap) => break,
            Err(other) => panic!("{other:?}"),
        }
    }
    assert_eq!(locks, 165);
    // Lock n carries the minimum in force with n - 1 locks open: 83 x 2, 25 x 5, 25 x 10, 17 x 25
    // and 15 x 50 USDC, against 165 x 2 = 330 without the ladder.
    assert_eq!(
        capital,
        166_000_000 + 125_000_000 + 250_000_000 + 425_000_000 + 750_000_000
    );
    assert_eq!(
        capital, 1_716_000_000,
        "1,716 USDC of attacker capital against 330 before the ladder"
    );
}

#[test]
fn an_unknown_outcome_is_counted_as_sent() {
    let limits = SponsorLimits::new(escalating());
    limits
        .reserve(net(1), Kind::Onboard, COSTS, 100, FUNDING)
        .unwrap()
        .unknown()
        .unwrap();
    assert_eq!(
        (
            limits.cac_spent(),
            limits.open_locks(),
            limits.unknown_sends()
        ),
        (924_160, 1, 1)
    );
    assert_eq!(
        limits.sponsored_by(net(1), 100),
        1,
        "the preparing network pays a slot"
    );
    // Dropping the reservation instead would have left no trace: the difference is what the test pins.
    let dropped = SponsorLimits::new(escalating());
    drop(
        dropped
            .reserve(net(1), Kind::Onboard, COSTS, 100, FUNDING)
            .unwrap(),
    );
    assert_eq!(
        (
            dropped.cac_spent(),
            dropped.open_locks(),
            dropped.sponsored_by(net(1), 100)
        ),
        (0, 0, 0)
    );
    // The janitor's reconcile corrects the open-lock count if the chain never shows the lock.
    limits.reconcile_open_locks(0).unwrap();
    assert_eq!(limits.open_locks(), 0);
}

#[test]
fn an_old_ledger_file_loads() {
    let dir = std::env::temp_dir().join(format!("sponsor-old-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("ledger.json");
    // The shape of the registration-only gateway's file: its outstanding count is ignored and its
    // networks, of another shape, are dropped.
    std::fs::write(
        &path,
        r#"{"outstanding":2,"networks":{"203.0.113.0/24":{"period":1,"count":2}}}"#,
    )
    .unwrap();
    let limits = SponsorLimits::open(caps(), &path).unwrap();
    assert_eq!(
        (
            limits.cac_spent(),
            limits.open_locks(),
            limits.unknown_sends()
        ),
        (0, 0, 0)
    );
    assert_eq!(limits.sponsored_by(net(1), 1), 0);
    limits
        .reserve(net(1), Kind::Onboard, COSTS, 100, FUNDING)
        .unwrap()
        .commit()
        .unwrap();
    assert_eq!(SponsorLimits::open(caps(), &path).unwrap().open_locks(), 1);
}

#[test]
fn a_pending_rotation_lends_its_rent_against_the_open_rent_cap_until_the_chain_says_otherwise() {
    const ROTATION_RENT: u64 = 1_426_800;
    let mut c = caps();
    c.open_rent_cap = 2 * ROTATION_RENT;
    let limits = SponsorLimits::new(c);
    let rotation = |n: u8| limits.reserve(net(n), Kind::Rotation(ROTATION_RENT), COSTS, 1, 0);
    rotation(1).unwrap().commit().unwrap();
    let held = rotation(2).unwrap();
    assert_eq!(
        rotation(3).err(),
        Some(Refusal::OpenRentCap),
        "one lent and one being prepared fill the cap"
    );
    drop(held);
    rotation(3).unwrap().commit().unwrap();
    assert_eq!(
        (limits.rotation_float(), limits.open_locks()),
        (2 * ROTATION_RENT, 0)
    );
    assert_eq!(rotation(4).err(), Some(Refusal::OpenRentCap));
    // The janitor reads the chain: one rotation was cancelled.
    limits.reconcile_rotation_float(ROTATION_RENT).unwrap();
    rotation(4).unwrap();
}
