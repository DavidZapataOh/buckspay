//! The attack on the float against the rule: if every lock held ten records for nothing and the
//! minimum amount was asked once per request, 94 locks with no bond
//! and 188 requests of five records stopped at `FloatCap` with 940 open records and 998,016,800
//! lamports lent, moving 584.75 USDC that came back to the attacker's own wallet.
use buckspay_gateway::float::*;
use buckspay_protocol::lock::RECORD_TTL;

const RENT: u64 = 1_061_720;
const NOW: u32 = 1_900_000_000;
const USDC: u64 = 1_000_000;

fn key(n: u32) -> [u8; 33] {
    let mut k = [0u8; 33];
    k[..4].copy_from_slice(&n.to_le_bytes());
    k
}

fn lock(n: u32) -> [u8; 32] {
    let mut l = [0u8; 32];
    l[..4].copy_from_slice(&n.to_le_bytes());
    l
}

fn address(n: u64) -> [u8; 32] {
    let mut a = [0; 32];
    a[..8].copy_from_slice(&n.to_le_bytes());
    a
}

struct Attack {
    locks: u32,
    issuers: u32,
    requests: u32,
    bond: u64,
    moved: u64,
    open_records: usize,
    float: u64,
    pressure: u8,
    stopped_by: Option<Refusal>,
}

/// The cheapest attacker the rules allow: it opens locks one after the other with just the bond
/// that gives the records still missing (at least `min_bond`), at most `max_locks_per_issuer` per
/// issuer key, fresh holder keys and networks for every request, requests of five records, and
/// the smallest amount the ladder accepts. `bond_of` is what a lock of `records` records costs it.
fn fill(limits: &std::sync::Arc<SettlementLimits>, caps: &Caps) -> Attack {
    let mut a = Attack {
        locks: 0,
        issuers: 0,
        requests: 0,
        bond: 0,
        moved: 0,
        open_records: 0,
        float: 0,
        pressure: 0,
        stopped_by: None,
    };
    let cap_records = caps.float_cap / RENT;
    let mut next = 0u64;
    'locks: for lock_index in 0..10_000u32 {
        let remaining = cap_records.saturating_sub(next);
        let share = remaining.min(u64::from(limits.lock_share(u64::MAX, RENT)));
        let bond = (share * caps.bond_per_record).max(caps.min_bond);
        let mut held = 0;
        let allowed = u64::from(limits.lock_share(bond, RENT));
        a.locks += 1;
        a.issuers = a.locks.div_ceil(caps.max_locks_per_issuer);
        a.bond += bond;
        while held < allowed {
            let count = (allowed - held).min(5);
            let status = limits.status(NOW);
            let amount = status.min_amount * count;
            let request = Request {
                kind: Kind::Settlement,
                prefix: Prefix::V4([10, (a.requests / 250) as u8, (a.requests % 250) as u8]),
                key: key(a.requests),
                issuer: key(1_000_000 + lock_index / caps.max_locks_per_issuer),
                lock: lock(lock_index),
                bond,
                amount,
                records: (next..next + count)
                    .map(|i| NewRecord {
                        address: address(i),
                        closable_at: NOW + 31 * 86_400,
                    })
                    .collect(),
                rent: RENT,
                now: NOW,
            };
            match limits.reserve(request) {
                Ok(r) => {
                    r.begin(NOW, 1_000, bond).unwrap().landed(1_002).unwrap();
                    a.requests += 1;
                    a.moved += amount;
                    held += count;
                    next += count;
                }
                Err(e) => {
                    a.stopped_by = Some(e);
                    break 'locks;
                }
            }
        }
    }
    let status = limits.status(NOW);
    a.open_records = status.open_records;
    a.float = status.open_float;
    a.pressure = status.pressure_percent;
    a
}

#[test]
fn filling_the_cap_costs_the_bond_of_every_record_it_holds() {
    let caps = Caps::pilot(RECORD_TTL);
    let limits = SettlementLimits::new(caps.clone());
    let a = fill(&limits, &caps);
    eprintln!(
        "locks {}, issuer keys {}, requests {}, bond locked {} USDC, open records {}, float {} lamports ({}%), recyclable amount moved {} USDC, stopped by {:?}",
        a.locks,
        a.issuers,
        a.requests,
        a.bond / USDC,
        a.open_records,
        a.float,
        a.pressure,
        a.moved as f64 / USDC as f64,
        a.stopped_by
    );
    assert_eq!(a.stopped_by, Some(Refusal::FloatCap));
    let cap_records = caps.float_cap / RENT;
    assert!(a.open_records as u64 >= cap_records - 5, "the cap is full");
    assert!(
        a.bond >= (cap_records - 5) * caps.bond_per_record,
        "every record held needs its share of bond: {} USDC for {} records",
        a.bond / USDC,
        a.open_records
    );
    assert!(a.locks >= 4, "no lock holds more than a quarter of the cap");
    // Afterwards an honest merchant with 100 USDC of bond is refused the float for two records
    // (one still fits in what the attacker's last request left), and the self-paid fallback is its
    // way out.
    let honest = Request {
        kind: Kind::Settlement,
        prefix: Prefix::V4([192, 0, 2]),
        key: key(9_999_999),
        issuer: key(9_999_998),
        lock: lock(9_999_997),
        bond: 100 * USDC,
        amount: 50 * USDC,
        records: (0..2)
            .map(|i| NewRecord {
                address: address((1 << 40) + i),
                closable_at: NOW + 31 * 86_400,
            })
            .collect(),
        rent: RENT,
        now: NOW,
    };
    assert_eq!(limits.reserve(honest).unwrap_err(), Refusal::FloatCap);
}

/// The attack on a rule with free records, replayed: locks with no bond, one after the other.
#[test]
fn locks_without_bond_get_nothing_however_many_there_are() {
    let caps = Caps::pilot(RECORD_TTL);
    let limits = SettlementLimits::new(caps.clone());
    for n in 0..94u32 {
        let request = Request {
            kind: Kind::Settlement,
            prefix: Prefix::V4([10, 0, n as u8]),
            key: key(n),
            issuer: key(n),
            lock: lock(n),
            bond: 0,
            amount: 5 * USDC,
            records: (0..5)
                .map(|i| NewRecord {
                    address: address(u64::from(n) * 5 + i),
                    closable_at: NOW + 31 * 86_400,
                })
                .collect(),
            rent: RENT,
            now: NOW,
        };
        assert_eq!(
            limits.reserve(request).unwrap_err(),
            Refusal::LockShare { allowed: 0 }
        );
    }
    assert_eq!(limits.status(NOW).open_float, 0);
}
