#![allow(dead_code)]
use buckspay_gateway::float::*;
use buckspay_protocol::lock::RECORD_TTL;
use std::sync::Arc;

pub const RENT: u64 = 1_061_720;
pub const NOW: u32 = 1_900_000_000;
pub const SLOT: u64 = 1_000;
pub const USDC: u64 = 1_000_000;

pub fn caps() -> Caps {
    Caps::pilot(RECORD_TTL)
}

pub fn net(n: u8) -> Prefix {
    Prefix::V4([10, 0, n])
}

pub fn address(n: u64) -> [u8; 32] {
    let mut a = [0; 32];
    a[..8].copy_from_slice(&n.to_le_bytes());
    a
}

pub fn records(first: u64, count: u64, closable: u32) -> Vec<NewRecord> {
    (first..first + count)
        .map(|i| NewRecord {
            address: address(i),
            closable_at: closable,
        })
        .collect()
}

/// A request of `key` and `lock` (one issuer key per lock unless a test says otherwise).
pub fn request(
    kind: Kind,
    key: u8,
    lock: u8,
    bond: u64,
    amount: u64,
    new: Vec<NewRecord>,
    now: u32,
) -> Request {
    Request {
        kind,
        prefix: net(key),
        key: [key; 33],
        issuer: [lock; 33],
        lock: [lock; 32],
        bond,
        amount,
        records: new,
        rent: RENT,
        now,
    }
}

pub fn settle(key: u8, lock: u8, first: u64, count: u64) -> Request {
    request(
        Kind::Settlement,
        key,
        lock,
        1_000 * USDC,
        count * USDC,
        records(first, count, NOW + 31 * DAY),
        NOW,
    )
}

/// The request is reserved, written down and confirmed landed.
pub fn land(limits: &Arc<SettlementLimits>, r: Request) {
    let bond = r.bond;
    limits
        .reserve(r)
        .unwrap()
        .begin(NOW, SLOT, bond)
        .unwrap()
        .landed(SLOT + 2)
        .unwrap();
}

pub fn begin(r: Reservation, bond: u64) -> Sending {
    r.begin(NOW, SLOT, bond).unwrap()
}
