//! The vocabulary of the limits: the caps, what a request asks for, why one is refused and what the
//! gateway quotes.
use serde::Serialize;

pub const DAY: u32 = 86_400;

pub use crate::limits::Prefix;

/// From `at_percent` of pressure on, the smallest amount per record the gateway sponsors is
/// `min_amount`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Step {
    pub at_percent: u8,
    pub min_amount: u64,
}

#[derive(Clone, Debug)]
pub struct Caps {
    /// Lamports of rent the gateway may have out in records, reservations included.
    pub float_cap: u64,
    /// Seconds: a request is refused when a record it creates would stay closed for longer.
    pub horizon: u32,
    /// A lock with less bond than this holds no sponsored record at all.
    pub min_bond: u64,
    /// A lock holds one open sponsored record for every `bond_per_record` of bond: capital that
    /// stays locked while the record is open and cannot be recycled by paying oneself.
    pub bond_per_record: u64,
    /// No lock may hold more than this percent of the cap.
    pub per_lock_max_percent: u8,
    /// Locks that hold open or reserved sponsored records at once, and of one issuer key.
    pub max_locks: u32,
    pub max_locks_per_issuer: u32,
    pub per_lock_per_day: u32,
    /// Holder keys cost an attacker nothing: these are speed bumps, not gates.
    pub per_key_per_day: u32,
    pub per_key_per_30_days: u32,
    pub per_prefix_per_day: u32,
    pub per_prefix_per_30_days: u32,
    pub preparing_per_prefix: u32,
    /// Sponsored settlements of notes relayed by other phones in one day: they all share the one
    /// bucket of `RELAY_PREFIX`, which stays under `daily_cap`.
    pub relay_per_day: u32,
    /// Relayed settlements being prepared at once.
    pub relay_preparing: u32,
    /// Sponsored requests of all kinds in one day; bounds every table of the ledger.
    pub daily_cap: u32,
    /// Seconds a reservation lives before it is swept.
    pub reservation_ttl: u32,
    /// Seconds a written-down send may still land (the blockhash lifetime, with a margin).
    pub unknown_grace: u32,
    /// Slots after a send was written down before a read without its records proves it never
    /// landed: the blockhash lifetime of 150 slots, with a margin.
    pub intent_slots: u64,
    /// Reads that must each lack a landed record, at ever later slots, before it is forgotten.
    pub missing_reads: u8,
    /// Seconds after `closable_at` before the janitor tries to close a record.
    pub close_margin: u32,
    /// The smallest amount sponsored for a request that creates no record: only the fee is spent.
    pub base_min_amount: u64,
    /// The smallest amount per new record at no pressure.
    pub record_min_amount: u64,
    /// Ascending in `at_percent`; the highest step reached applies.
    pub steps: Vec<Step>,
    /// The retention of a record that is closable at once: the floor of `horizon`.
    pub record_ttl: u32,
}

impl Caps {
    /// Pilot values (6-decimal token base units, lamports).
    pub fn pilot(record_ttl: u32) -> Self {
        Self {
            float_cap: 1_000_000_000,
            horizon: 45 * DAY,
            min_bond: 10_000_000,
            bond_per_record: 1_000_000,
            per_lock_max_percent: 25,
            max_locks: 128,
            max_locks_per_issuer: 3,
            per_lock_per_day: 200,
            per_key_per_day: 20,
            per_key_per_30_days: 200,
            per_prefix_per_day: 400,
            per_prefix_per_30_days: 4_000,
            preparing_per_prefix: 8,
            relay_per_day: 1_000,
            relay_preparing: 64,
            daily_cap: 5_000,
            reservation_ttl: 90,
            unknown_grace: 120,
            intent_slots: 300,
            missing_reads: 3,
            close_margin: 120,
            base_min_amount: 50_000,
            record_min_amount: 50_000,
            steps: vec![
                Step {
                    at_percent: 50,
                    min_amount: 250_000,
                },
                Step {
                    at_percent: 65,
                    min_amount: 1_000_000,
                },
                Step {
                    at_percent: 80,
                    min_amount: 5_000_000,
                },
                Step {
                    at_percent: 90,
                    min_amount: 25_000_000,
                },
            ],
            record_ttl,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Settlement,
    Reclaim,
}

/// A record the request would create.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NewRecord {
    pub address: [u8; 32],
    pub closable_at: u32,
}

/// What a request asks the gateway to sponsor, read from the chain at `confirmed`.
#[derive(Clone, Debug)]
pub struct Request {
    pub kind: Kind,
    pub prefix: Prefix,
    /// The holder key that signed the settlement spend, or the owner of the reclaimed output.
    pub key: [u8; 33],
    /// The issuer's device key, its lock address and the lock's bond.
    pub issuer: [u8; 33],
    pub lock: [u8; 32],
    pub bond: u64,
    /// What the request moves, in token base units.
    pub amount: u64,
    /// Only the records that do not exist yet.
    pub records: Vec<NewRecord>,
    /// `rent(81)` read from the RPC.
    pub rent: u64,
    pub now: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The ledger could not be written: nothing is sponsored until it can.
    Unwritable,
    DailyCap,
    /// Below the smallest sponsored total for this request, carried so the app can show it.
    BelowMinimum(u64),
    /// A record would stay closed too long; the request fits from `retry_at` on.
    Horizon {
        retry_at: u32,
    },
    PrefixBusy,
    PrefixSpentToday,
    PrefixSpentThisMonth,
    KeySpentToday,
    KeySpentThisMonth,
    LockSpentToday,
    /// The lock holds as many open records as its bond allows.
    LockShare {
        allowed: u32,
    },
    /// As many locks hold sponsored records as the gateway allows, or the issuer key holds in
    /// that many.
    TooManyLocks,
    IssuerLocks,
    FloatCap,
    /// The reservation was swept before the transaction was sent.
    Expired,
}

/// What the gateway quotes and enforces right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Status {
    pub pressure_percent: u8,
    /// The smallest amount per new record in force.
    pub min_amount: u64,
    pub open_records: usize,
    pub open_float: u64,
    pub locks: usize,
}
